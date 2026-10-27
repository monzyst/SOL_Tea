/**
 * packages/executor — transaction assembly, submission and outcome capture.
 *
 * Hot-path budget: at most one `getLatestBlockhash` per attempt, one signature
 * request, one send. There is no retry loop here — retrying is a *policy*
 * decision, and re-signing blindly is how a "failed" transaction executes twice.
 *
 * Outcomes are classified explicitly because the three cases need different
 * responses (V6 §08):
 *   INCLUDED — confirmed on chain; reconcile deltas.
 *   REVERTED — landed but the program rejected it: the fee was still spent.
 *   UNKNOWN  — we do not know; MUST be reconciled, never assumed failed.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type Connection,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Logger } from '../../obs/src';
import type { SignedOutbox } from '../../journal/src';
import type { Signer } from '../../signer/src';
import { buildSwapInstruction, type ExecutableQuote } from '../../../chains/solana/src/quoter';
import type { PoolBinding } from '../../registry/src';

export type ExecutionOutcome = 'INCLUDED' | 'REVERTED' | 'UNKNOWN' | 'NOT_SENT';

export interface ExecutionRequest {
  readonly intentId: string;
  readonly routeKey: string;
  readonly buyBinding: PoolBinding;
  readonly sellBinding: PoolBinding;
  readonly programId: string;
  readonly buyQuote: ExecutableQuote;
  readonly sellQuote: ExecutableQuote;
  readonly maxComputeUnits: number;
  readonly priorityFeeMicroLamports: number;
  readonly commitment: 'confirmed' | 'finalized';
}

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly nativeFeeLamports: bigint | null;
  readonly error: string | null;
  readonly submittedAtUtc: string;
}

export interface ExecutorDeps {
  readonly connection: Connection;
  readonly signer: Signer;
  readonly journal: SignedOutbox;
  readonly logger: Logger;
  readonly nowUtc?: () => Date;
}

/**
 * Worst-case native fee. 5,000 lamports per signature is the base fee; the
 * priority fee is charged per compute unit over 1e6 units.
 */
export function estimateWorstCaseFeeLamports(input: {
  signatureCount: number;
  computeUnits: number;
  priorityFeeMicroLamports: number;
}): bigint {
  const base = BigInt(5_000) * BigInt(Math.max(1, input.signatureCount));
  const priority = (BigInt(input.computeUnits) * BigInt(input.priorityFeeMicroLamports)) / 1_000_000n;
  return base + priority;
}

export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Build, journal, sign and submit one two-leg cycle.
   *
   * Message bytes are journaled *before* signing and verified by the signer, so
   * the artifact on disk provably matches what was signed.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { connection, signer, journal, logger } = this.deps;
    const submittedAtUtc = (this.deps.nowUtc ?? (() => new Date()))().toISOString();

    if (!signer.isArmed() || !signer.publicKey) {
      logger.warn('execution_skipped', { intentId: request.intentId, reason: 'signer-not-armed' });
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'REJECTED',
        payload: { reason: 'SIGNER_NOT_ARMED' },
      });
      return {
        outcome: 'NOT_SENT',
        signature: null,
        slot: null,
        nativeFeeLamports: null,
        error: 'signer not armed',
        submittedAtUtc,
      };
    }

    const owner = signer.publicKey;
    const transaction = new Transaction();

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(request.commitment);
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = owner;

      transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: request.maxComputeUnits }));
      if (request.priorityFeeMicroLamports > 0) {
        transaction.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: request.priorityFeeMicroLamports,
          }),
        );
      }

      // Idempotent ATAs: created on the first run, no-ops afterwards.
      const tokenA = getAssociatedTokenAddressSync(new PublicKey(request.buyBinding.mintA), owner);
      const tokenB = getAssociatedTokenAddressSync(new PublicKey(request.buyBinding.mintB), owner);
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          tokenA,
          owner,
          new PublicKey(request.buyBinding.mintA),
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          tokenB,
          owner,
          new PublicKey(request.buyBinding.mintB),
        ),
      );

      // Both legs are built from the SAME quoted thresholds.
      const leg1 = await buildSwapInstruction({
        connection,
        binding: request.buyBinding,
        programId: request.programId,
        owner,
        quote: request.buyQuote,
        tokenOwnerAccountA: tokenA,
        tokenOwnerAccountB: tokenB,
      });
      const leg2 = await buildSwapInstruction({
        connection,
        binding: request.sellBinding,
        programId: request.programId,
        owner,
        quote: request.sellQuote,
        tokenOwnerAccountA: tokenA,
        tokenOwnerAccountB: tokenB,
      });
      transaction.add(leg1.instruction, ...leg1.cleanup, leg2.instruction, ...leg2.cleanup);

      const messageBase64 = Buffer.from(transaction.serializeMessage()).toString('base64');

      // Journal the exact bytes BEFORE the signer ever sees them.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'ADMITTED',
        signature: null,
        payload: {
          buyPool: request.buyBinding.address,
          sellPool: request.sellBinding.address,
          messageFingerprint: messageBase64.slice(0, 16),
        },
      });

      const signed = await signer.sign({
        intentId: request.intentId,
        expectedMessageBase64: messageBase64,
        transaction,
      });

      // A SIGNED record on disk is what makes a crash between here and submit
      // recoverable: the transaction may already be on chain.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SIGNED',
        signature: signed.signature,
        payload: { messageFingerprint: messageBase64.slice(0, 16) },
      });

      const raw = transaction.serialize();
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: request.commitment,
      });

      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTED',
        signature,
      });

      return await this.awaitOutcome({
        signature,
        lastValidBlockHeight,
        intentId: request.intentId,
        routeKey: request.routeKey,
        commitment: request.commitment,
        submittedAtUtc,
      });
    } catch (error) {
      const message = (error as Error).message;
      // A build/sign failure provably never reached the network.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'FAILED',
        payload: { stage: 'PRE_SUBMIT', error: message },
      });
      logger.error('execution_failed_pre_submit', { intentId: request.intentId, error: message });
      return {
        outcome: 'NOT_SENT',
        signature: null,
        slot: null,
        nativeFeeLamports: null,
        error: message,
        submittedAtUtc,
      };
    }
  }

  /**
   * Poll for inclusion until the blockhash expires. Expiry is reported as
   * UNKNOWN, never FAILED: a dropped transaction and a slow one look identical
   * from here, and only reconciliation can distinguish them.
   */
  private async awaitOutcome(input: {
    signature: string;
    lastValidBlockHeight: number;
    intentId: string;
    routeKey: string;
    commitment: 'confirmed' | 'finalized';
    submittedAtUtc: string;
  }): Promise<ExecutionResult> {
    const { connection, journal, logger } = this.deps;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const statuses = await connection.getSignatureStatuses([input.signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];

      if (status?.err) {
        const fee = await this.readFee(input.signature);
        journal.append({
          intentId: input.intentId,
          routeKey: input.routeKey,
          state: 'FAILED',
          signature: input.signature,
          payload: {
            stage: 'ON_CHAIN_REVERT',
            error: JSON.stringify(status.err),
            fee: fee?.toString() ?? null,
          },
        });
        logger.warn('tx_reverted', { intentId: input.intentId, err: status.err });
        return {
          outcome: 'REVERTED',
          signature: input.signature,
          slot: status.slot,
          nativeFeeLamports: fee,
          error: JSON.stringify(status.err),
          submittedAtUtc: input.submittedAtUtc,
        };
      }

      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        const fee = await this.readFee(input.signature);
        journal.append({
          intentId: input.intentId,
          routeKey: input.routeKey,
          state: 'INCLUDED',
          signature: input.signature,
          payload: { slot: status.slot, fee: fee?.toString() ?? null },
        });
        logger.info('tx_included', { intentId: input.intentId, slot: status.slot });
        return {
          outcome: 'INCLUDED',
          signature: input.signature,
          slot: status.slot,
          nativeFeeLamports: fee,
          error: null,
          submittedAtUtc: input.submittedAtUtc,
        };
      }

      const height = await connection.getBlockHeight(input.commitment);
      if (height > input.lastValidBlockHeight) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    journal.append({
      intentId: input.intentId,
      routeKey: input.routeKey,
      state: 'SUBMITTED',
      signature: input.signature,
      payload: { note: 'OUTCOME_UNKNOWN_PENDING_RECONCILIATION' },
    });
    logger.warn('tx_outcome_unknown', { intentId: input.intentId, signature: input.signature });
    return {
      outcome: 'UNKNOWN',
      signature: input.signature,
      slot: null,
      nativeFeeLamports: null,
      error: 'blockhash expired before confirmation',
      submittedAtUtc: input.submittedAtUtc,
    };
  }

  private async readFee(signature: string): Promise<bigint | null> {
    try {
      const tx = await this.deps.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      return tx?.meta ? BigInt(tx.meta.fee) : null;
    } catch {
      return null;
    }
  }
}
