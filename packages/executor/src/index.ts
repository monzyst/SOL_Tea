/**
 * packages/executor — transaction assembly, submission and outcome capture.
 *
 * The contract this module upholds:
 *  - journal ADMITTED before anything is built
 *  - journal SIGNED before broadcast (so a crash leaves a trace)
 *  - never retry a signed transaction (retry is a policy decision upstream)
 *  - distinguish NOT_SENT (provably never broadcast) from UNKNOWN (may have landed)
 *
 * Conflating those last two is how a fee gets paid twice for one intended trade.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { Logger } from '../../obs/src';
import { fingerprintMessage, type SignedOutbox } from '../../journal/src';
import type { Signer } from '../../signer/src';
import { fingerprint } from '../../signer/src';

export type ExecutionOutcome = 'INCLUDED' | 'REVERTED' | 'UNKNOWN' | 'NOT_SENT';

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly error: string | null;
  readonly nativeFeeLamports: bigint | null;
}

export interface ExecutionRequest {
  readonly intentId: string;
  readonly routeKey: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly payer: PublicKey;
  readonly computeUnits: number;
  readonly priorityFeeMicroLamports: number;
  /** On-chain minimum for the WHOLE cycle, already slippage-adjusted. */
  readonly minimumAmountOutRaw: bigint;
}

/**
 * Worst-case native fee. Reserving the worst case can only return headroom
 * later; reserving a guess can overdraw the period cap.
 */
export function estimateWorstCaseFeeLamports(input: {
  signatureCount: number;
  computeUnits: number;
  priorityFeeMicroLamports: number;
}): bigint {
  const base = 5_000n * BigInt(input.signatureCount);
  const priority =
    (BigInt(input.computeUnits) * BigInt(input.priorityFeeMicroLamports)) / 1_000_000n;
  return base + priority;
}

export class Executor {
  constructor(
    private readonly deps: {
      connection: Connection;
      signer: Signer;
      journal: SignedOutbox;
      logger: Logger;
      commitment?: 'confirmed' | 'finalized';
    },
  ) {}

  /**
   * Build, sign and submit one attempt. Returns an outcome instead of throwing,
   * because "how did it fail" determines what may be done next.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { journal, logger, signer, connection } = this.deps;
    const commitment = this.deps.commitment ?? 'confirmed';

    if (!signer.isArmed()) {
      return { outcome: 'NOT_SENT', signature: null, slot: null, error: 'signer-not-armed', nativeFeeLamports: null };
    }

    journal.append({
      intentId: request.intentId,
      routeKey: request.routeKey,
      state: 'ADMITTED',
      payload: {
        instructions: request.instructions.length,
        computeUnits: request.computeUnits,
        priorityFeeMicroLamports: request.priorityFeeMicroLamports,
        minimumAmountOutRaw: request.minimumAmountOutRaw.toString(),
      },
    });

    let transaction: VersionedTransaction;
    try {
      const { blockhash } = await connection.getLatestBlockhash(commitment);
      const message = new TransactionMessage({
        payerKey: request.payer,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: request.computeUnits }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: request.priorityFeeMicroLamports,
          }),
          ...request.instructions,
        ],
      }).compileToV0Message();
      transaction = new VersionedTransaction(message);
    } catch (error) {
      // Nothing was signed or sent: this is provably not on chain.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'NOT_SENT',
        payload: { stage: 'build', error: (error as Error).message },
      });
      logger.error('tx_build_failed', { intentId: request.intentId, error: (error as Error).message });
      return {
        outcome: 'NOT_SENT',
        signature: null,
        slot: null,
        error: (error as Error).message,
        nativeFeeLamports: null,
      };
    }

    // The admitted message bytes are the only message that may be signed.
    const messageFingerprint = fingerprint(transaction) === '' ? '' : fingerprintMessage(transaction.message.serialize());

    let signature: string;
    try {
      const signed = await signer.signIntent({
        intentId: request.intentId,
        messageFingerprint,
        transaction,
      });
      signature = signed.signature;
      transaction = signed.transaction;
    } catch (error) {
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'NOT_SENT',
        payload: { stage: 'sign', error: (error as Error).message },
      });
      logger.error('tx_sign_failed', { intentId: request.intentId, error: (error as Error).message });
      return {
        outcome: 'NOT_SENT',
        signature: null,
        slot: null,
        error: (error as Error).message,
        nativeFeeLamports: null,
      };
    }

    // SIGNED must be durable BEFORE the bytes leave the process.
    journal.append({
      intentId: request.intentId,
      routeKey: request.routeKey,
      state: 'SIGNED',
      signature,
      messageFingerprint,
    });

    try {
      await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: commitment,
      });
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTED',
        signature,
      });
    } catch (error) {
      // A failed send may still have reached the cluster; that is UNKNOWN, not
      // NOT_SENT. Reconciliation, not optimism, decides.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'UNKNOWN',
        signature,
        payload: { stage: 'send', error: (error as Error).message },
      });
      logger.warn('tx_send_unknown', { intentId: request.intentId, signature, error: (error as Error).message });
      return {
        outcome: 'UNKNOWN',
        signature,
        slot: null,
        error: (error as Error).message,
        nativeFeeLamports: null,
      };
    }

    return this.awaitOutcome({ intentId: request.intentId, routeKey: request.routeKey, signature });
  }

  /** Wait for inclusion, or conclude honestly that the outcome is unknown. */
  async awaitOutcome(input: {
    intentId: string;
    routeKey: string;
    signature: string;
  }): Promise<ExecutionResult> {
    const { journal, logger, connection } = this.deps;

    try {
      const confirmation = await connection.confirmTransaction(input.signature, 'confirmed');
      const status = await connection.getSignatureStatus(input.signature);
      const slot = status.context.slot;

      if (confirmation.value.err) {
        // Landed and failed: the fee is genuinely spent.
        journal.append({
          intentId: input.intentId,
          routeKey: input.routeKey,
          state: 'REVERTED',
          signature: input.signature,
          payload: { slot, error: JSON.stringify(confirmation.value.err) },
        });
        logger.warn('tx_reverted', { intentId: input.intentId, signature: input.signature, slot });
        return {
          outcome: 'REVERTED',
          signature: input.signature,
          slot,
          error: JSON.stringify(confirmation.value.err),
          nativeFeeLamports: 5_000n,
        };
      }

      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'INCLUDED',
        signature: input.signature,
        payload: { slot },
      });
      logger.info('tx_included', { intentId: input.intentId, signature: input.signature, slot });
      return {
        outcome: 'INCLUDED',
        signature: input.signature,
        slot,
        error: null,
        nativeFeeLamports: 5_000n,
      };
    } catch (error) {
      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'UNKNOWN',
        signature: input.signature,
        payload: { stage: 'confirm', error: (error as Error).message },
      });
      logger.error('tx_outcome_unknown', {
        intentId: input.intentId,
        signature: input.signature,
        error: (error as Error).message,
      });
      return {
        outcome: 'UNKNOWN',
        signature: input.signature,
        slot: null,
        error: (error as Error).message,
        nativeFeeLamports: null,
      };
    }
  }
}
