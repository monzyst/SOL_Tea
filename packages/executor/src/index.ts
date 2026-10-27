/**
 * packages/executor — transaction assembly, submission and outcome capture.
 *
 * Hot-path budget: at most one `getLatestBlockhash` per attempt, one signature
 * request, one send. There is no retry loop here — retrying is a *policy*
 * decision, and re-signing blindly is how a "failed" transaction executes twice.
 *
 * Outcome classification. The three failure modes need three different
 * responses, and conflating them is how an engine loses money without knowing:
 *   INCLUDED            — at the requested commitment; reconcile deltas.
 *   AWAITING_FINALITY   — provisionally included, not final yet (audit T05).
 *   REVERTED            — landed but the program rejected it: the fee was spent.
 *   UNKNOWN             — we do not know; MUST be reconciled, never assumed failed.
 *   NOT_SENT            — provably never reached the network.
 *
 * Audit T03 (fixed here): the previous revision wrapped submission AND outcome
 * polling in one try/catch and returned NOT_SENT with a null signature from
 * either. Once `sendRawTransaction` has been called the transaction may already
 * be on chain, so "not sent" is a lie that hides real exposure. This version
 * tracks an explicit stage, keeps the locally computed signature, and any
 * ambiguity after dispatch is UNKNOWN — never NOT_SENT.
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
import { messageDigest, type SignedOutbox } from '../../journal/src';
import { SignerError, type Signer } from '../../signer/src';
import { buildSwapInstruction, type ExecutableQuote } from '../../../chains/solana/src/quoter';
import type { PoolBinding } from '../../registry/src';
import { encodeBase58, mulDivCeil } from '../../domain/src';

/**
 * Every stage an attempt can be in. The distinction that matters is
 * before/after DISPATCHING: everything before it is provably not on chain,
 * everything from it onwards may be.
 */
export type ExecutionStage =
  | 'BUILD'
  | 'ADMITTED'
  | 'SIGNED'
  | 'DISPATCHING'
  | 'DISPATCHED'
  | 'AWAITING_FINALITY'
  | 'SETTLED';

export type ExecutionOutcome = 'INCLUDED' | 'AWAITING_FINALITY' | 'REVERTED' | 'UNKNOWN' | 'NOT_SENT';

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
  /** Absolute deadline for the attempt; a stale quote must never be signed. */
  readonly quoteExpiresAtUtc?: string;
}

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  /** How far the attempt got. Always journaled, so a crash is reconstructable. */
  readonly stage: ExecutionStage;
  /** Locally computed signature — non-null from SIGNED onwards. */
  readonly signature: string | null;
  readonly slot: number | null;
  readonly nativeFeeLamports: bigint | null;
  readonly error: string | null;
  readonly submittedAtUtc: string;
  /** True once `sendRawTransaction` was entered. Gates NOT_SENT. */
  readonly dispatchAttempted: boolean;
  /** Message digest recorded before signing, for post-hoc byte comparison. */
  readonly messageSha256: string | null;
}

export interface ExecutorDeps {
  readonly connection: Connection;
  readonly signer: Signer;
  readonly journal: SignedOutbox;
  readonly logger: Logger;
  readonly nowUtc?: () => Date;
  /** Injected for tests; defaults to a 1s poll with a 60s ceiling. */
  readonly pollIntervalMs?: number;
  readonly outcomeTimeoutMs?: number;
}

/** Base fee per signature on Solana mainnet, in lamports. */
export const BASE_FEE_PER_SIGNATURE_LAMPORTS = 5_000n;

/**
 * Rent-exempt minimum for a 165-byte SPL token account, in lamports.
 *
 * Worst-case fee accounting includes ATA rent because the first attempt for a
 * new token pair CREATES two associated token accounts and that cost is real
 * native spend. Ignoring it makes the per-attempt cap optimistic, and an
 * optimistic cap is how a fee budget gets silently overrun (audit T06).
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * Worst-case native cost of one attempt.
 *
 * Every term rounds UP: base fee is exact, the priority fee is
 * `ceil(computeUnits * microLamports / 1e6)` — the previous revision divided
 * and truncated, understating the number used for the policy cap check. Costs
 * must never be rounded down in the trader's favour.
 */
export function estimateWorstCaseFeeLamports(input: {
  signatureCount: number;
  computeUnits: number;
  priorityFeeMicroLamports: number;
  /** ATAs that may need creating on this attempt. */
  tokenAccountsToCreate?: number;
}): bigint {
  const base = BASE_FEE_PER_SIGNATURE_LAMPORTS * BigInt(Math.max(1, input.signatureCount));
  const priority = mulDivCeil(
    BigInt(Math.max(0, input.computeUnits)),
    BigInt(Math.max(0, Math.ceil(input.priorityFeeMicroLamports))),
    1_000_000n,
  );
  const rent = TOKEN_ACCOUNT_RENT_LAMPORTS * BigInt(Math.max(0, input.tokenAccountsToCreate ?? 0));
  return base + priority + rent;
}

export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Build, journal, sign and submit one two-leg cycle.
   *
   * The message bytes are journaled *before* signing and the signer re-derives
   * them, so the artifact on disk provably matches what was signed.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { connection, signer, journal, logger } = this.deps;
    const now = this.deps.nowUtc ?? (() => new Date());
    const submittedAtUtc = now().toISOString();

    const bail = (stage: ExecutionStage, error: string, outcome: ExecutionOutcome = 'NOT_SENT'): ExecutionResult => ({
      outcome,
      stage,
      signature: null,
      slot: null,
      nativeFeeLamports: null,
      error,
      submittedAtUtc,
      dispatchAttempted: false,
      messageSha256: null,
    });

    if (!signer.isArmed() || !signer.publicKey) {
      logger.warn('execution_skipped', { intentId: request.intentId, reason: 'signer-not-armed' });
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'REJECTED',
        payload: { reason: 'SIGNER_NOT_ARMED' },
      });
      return bail('BUILD', 'signer not armed');
    }

    if (request.quoteExpiresAtUtc !== undefined) {
      const expiry = Date.parse(request.quoteExpiresAtUtc);
      if (Number.isNaN(expiry) || expiry <= now().getTime()) {
        logger.warn('execution_skipped', { intentId: request.intentId, reason: 'quote-expired' });
        journal.append({
          intentId: request.intentId,
          routeKey: request.routeKey,
          state: 'REJECTED',
          payload: { reason: 'QUOTE_EXPIRED', quoteExpiresAtUtc: request.quoteExpiresAtUtc },
        });
        return bail('BUILD', 'quote expired before signing');
      }
    }

    const owner = signer.publicKey;
    const transaction = new Transaction();
    let lastValidBlockHeight: number;
    let messageSha256: string;

    /* ---------------- 1. build (no side effects, provably not sent) -------- */
    try {
      const { blockhash, lastValidBlockHeight: height } = await connection.getLatestBlockhash(
        request.commitment,
      );
      lastValidBlockHeight = height;
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = height;
      transaction.feePayer = owner;

      transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: request.maxComputeUnits }));
      if (request.priorityFeeMicroLamports > 0) {
        transaction.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.ceil(request.priorityFeeMicroLamports),
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

      const messageBytes = transaction.serializeMessage();
      messageSha256 = messageDigest(messageBytes);

      // Journal the exact bytes BEFORE the signer ever sees them (audit T04:
      // the FULL message, not a display prefix — recovery needs the artifact).
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'ADMITTED',
        payload: {
          buyPool: request.buyBinding.address,
          sellPool: request.sellBinding.address,
          messageSha256,
          messageBase64: messageBytes.toString('base64'),
          messageByteLength: messageBytes.length,
          recentBlockhash: blockhash,
          lastValidBlockHeight,
          computeUnitLimit: request.maxComputeUnits,
          computeUnitPriceMicroLamports: request.priorityFeeMicroLamports,
          commitment: request.commitment,
        },
      });
    } catch (error) {
      const message = (error as Error).message;
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'FAILED',
        payload: { stage: 'PRE_SUBMIT_BUILD', error: message },
      });
      logger.error('execution_failed_pre_submit', { intentId: request.intentId, error: message });
      return bail('BUILD', message);
    }

    /* ---------------- 2. sign (still provably not sent) -------------------- */
    let signature: string;
    try {
      const signed = await signer.sign({
        intentId: request.intentId,
        expectedMessageBase64: Buffer.from(transaction.serializeMessage()).toString('base64'),
        transaction,
        expectedMessageSha256: messageSha256,
        intent: {
          buyPool: request.buyBinding.address,
          sellPool: request.sellBinding.address,
          maxComputeUnits: request.maxComputeUnits,
          priorityFeeMicroLamports: request.priorityFeeMicroLamports,
          commitment: request.commitment,
        },
      });
      signature = signed.signature;
    } catch (error) {
      const message = (error as Error).message;
      const code = error instanceof SignerError ? error.code : 'SIGN_FAILED';
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'FAILED',
        payload: { stage: 'PRE_SUBMIT_SIGN', error: message, code },
      });
      logger.error('execution_sign_failed', { intentId: request.intentId, code, error: message });
      // A refused signature never produced a transaction for the network.
      return bail('SIGNED', message);
    }

    // The SIGNED record is what makes a crash between here and submit
    // recoverable: the transaction may already be on chain.
    const signedWire = transaction.serialize();
    journal.append({
      intentId: request.intentId,
      routeKey: request.routeKey,
      state: 'SIGNED',
      signature,
      payload: {
        messageSha256,
        signedTransactionBase64: signedWire.toString('base64'),
        signedTransactionBytes: signedWire.length,
        lastValidBlockHeight,
      },
    });

    /* ---------------- 3. dispatch (IRREVERSIBLE — ambiguity = UNKNOWN) ------ */
    let dispatched = false;
    let dispatchError: string | null = null;
    try {
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTING',
        signature,
        payload: { note: 'DISPATCH_ATTEMPTED' },
      });
      dispatched = true;
      // Recorded before the call resolves, so a crash mid-send still leaves
      // evidence that this signature MAY be live.
      const rpcSignature = await connection.sendRawTransaction(signedWire, {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: request.commitment,
      });
      if (rpcSignature !== signature) {
        // Should be impossible; if it happens the journal's signature is not the
        // one the cluster tracks, so neither can be trusted for reconciliation.
        logger.error('signature_mismatch', { intentId: request.intentId, local: signature, rpc: rpcSignature });
        dispatchError = `rpc returned a different signature (${rpcSignature})`;
      }
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTED',
        signature,
        payload: { rpcSignature },
      });
    } catch (error) {
      dispatchError = (error as Error).message;
      logger.warn('dispatch_failed_ambiguous', {
        intentId: request.intentId,
        signature,
        error: dispatchError,
      });
      // Do NOT classify as FAILED: the send may have been accepted before the
      // connection broke. The signature stays known so reconciliation can ask.
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTED',
        signature,
        payload: { note: 'DISPATCH_ERROR_OUTCOME_UNKNOWN', error: dispatchError },
      });
    }

    if (!dispatched) {
      // Only reachable if the journal write above threw, which propagates.
      return {
        outcome: 'UNKNOWN',
        stage: 'SIGNED',
        signature,
        slot: null,
        nativeFeeLamports: null,
        error: 'dispatch was never entered',
        submittedAtUtc,
        dispatchAttempted: false,
        messageSha256,
      };
    }

    /* ---------------- 4. outcome (errors here are UNKNOWN, never FAILED) --- */
    let outcomeResult: ExecutionResult;
    try {
      outcomeResult = await this.awaitOutcome({
        signature,
        lastValidBlockHeight,
        intentId: request.intentId,
        routeKey: request.routeKey,
        commitment: request.commitment,
        submittedAtUtc,
        messageSha256,
      });
    } catch (error) {
      const message = (error as Error).message;
      journal.append({
        intentId: request.intentId,
        routeKey: request.routeKey,
        state: 'SUBMITTED',
        signature,
        payload: { note: 'OUTCOME_POLL_ERROR_PENDING_RECONCILIATION', error: message },
      });
      logger.error('outcome_poll_failed', { intentId: request.intentId, signature, error: message });
      outcomeResult = {
        outcome: 'UNKNOWN',
        stage: 'DISPATCHED',
        signature,
        slot: null,
        nativeFeeLamports: null,
        error: message,
        submittedAtUtc,
        dispatchAttempted: true,
        messageSha256,
      };
    }

    if (dispatchError !== null && outcomeResult.outcome === 'UNKNOWN') {
      // Keep the RPC's own complaint, which is more specific than "expired".
      return { ...outcomeResult, error: dispatchError };
    }
    return outcomeResult;
  }

  /**
   * Poll for inclusion until the blockhash expires.
   *
   * Commitment is ENFORCED, not advisory (audit T05): when the caller asked for
   * `finalized`, a merely `confirmed` inclusion is reported as
   * AWAITING_FINALITY and journaled as such — provisional inclusion is not final
   * settlement, and quietly treating it as INCLUDED overstates certainty.
   *
   * Expiry is reported as UNKNOWN, never FAILED: a dropped transaction and a
   * slow one look identical from here, and only reconciliation can distinguish
   * them.
   */
  private async awaitOutcome(input: {
    signature: string;
    lastValidBlockHeight: number;
    intentId: string;
    routeKey: string;
    commitment: 'confirmed' | 'finalized';
    submittedAtUtc: string;
    messageSha256: string;
  }): Promise<ExecutionResult> {
    const { connection, journal, logger } = this.deps;
    const pollIntervalMs = this.deps.pollIntervalMs ?? 1_000;
    const timeoutMs = this.deps.outcomeTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let provisionalSlot: number | null = null;

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
          stage: 'SETTLED',
          signature: input.signature,
          slot: status.slot,
          nativeFeeLamports: fee,
          error: JSON.stringify(status.err),
          submittedAtUtc: input.submittedAtUtc,
          dispatchAttempted: true,
          messageSha256: input.messageSha256,
        };
      }

      const level = status?.confirmationStatus ?? null;
      if (level === 'finalized') {
        const fee = await this.readFee(input.signature);
        journal.append({
          intentId: input.intentId,
          routeKey: input.routeKey,
          state: 'FINALIZED',
          signature: input.signature,
          payload: { slot: status?.slot ?? provisionalSlot, fee: fee?.toString() ?? null },
        });
        logger.info('tx_finalized', { intentId: input.intentId, slot: status?.slot });
        return {
          outcome: 'INCLUDED',
          stage: 'SETTLED',
          signature: input.signature,
          slot: status?.slot ?? provisionalSlot,
          nativeFeeLamports: fee,
          error: null,
          submittedAtUtc: input.submittedAtUtc,
          dispatchAttempted: true,
          messageSha256: input.messageSha256,
        };
      }

      if (level === 'confirmed') {
        provisionalSlot = status?.slot ?? provisionalSlot;
        if (input.commitment === 'confirmed') {
          const fee = await this.readFee(input.signature);
          journal.append({
            intentId: input.intentId,
            routeKey: input.routeKey,
            state: 'INCLUDED',
            signature: input.signature,
            payload: { slot: status?.slot, fee: fee?.toString() ?? null, commitment: 'confirmed' },
          });
          logger.info('tx_included', { intentId: input.intentId, slot: status?.slot });
          return {
            outcome: 'INCLUDED',
            stage: 'SETTLED',
            signature: input.signature,
            slot: status?.slot ?? null,
            nativeFeeLamports: fee,
            error: null,
            submittedAtUtc: input.submittedAtUtc,
            dispatchAttempted: true,
            messageSha256: input.messageSha256,
          };
        }
        // Caller asked for finalized. Keep waiting for finality, but say so.
        journal.append({
          intentId: input.intentId,
          routeKey: input.routeKey,
          state: 'AWAITING_FINALITY',
          signature: input.signature,
          payload: { slot: status?.slot, note: 'CONFIRMED_NOT_FINAL' },
        });
      }

      const height = await connection.getBlockHeight(input.commitment);
      if (height > input.lastValidBlockHeight) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (provisionalSlot !== null) {
      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'AWAITING_FINALITY',
        signature: input.signature,
        payload: { slot: provisionalSlot, note: 'CONFIRMED_PENDING_FINALITY_TIMEOUT' },
      });
      logger.warn('tx_awaiting_finality', { intentId: input.intentId, slot: provisionalSlot });
      return {
        outcome: 'AWAITING_FINALITY',
        stage: 'AWAITING_FINALITY',
        signature: input.signature,
        slot: provisionalSlot,
        nativeFeeLamports: null,
        error: 'confirmed but not finalized before timeout',
        submittedAtUtc: input.submittedAtUtc,
        dispatchAttempted: true,
        messageSha256: input.messageSha256,
      };
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
      stage: 'DISPATCHED',
      signature: input.signature,
      slot: null,
      nativeFeeLamports: null,
      error: 'blockhash expired before confirmation',
      submittedAtUtc: input.submittedAtUtc,
      dispatchAttempted: true,
      messageSha256: input.messageSha256,
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

/** Solana signature as base58 from the signed transaction (never base64). */
export function signatureOf(transaction: Transaction): string | null {
  const sig = transaction.signature;
  return sig ? encodeBase58(sig) : null;
}
