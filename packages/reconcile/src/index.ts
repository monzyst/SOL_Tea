/**
 * packages/reconcile — turn on-chain receipts into accounting truth.
 *
 * The rule this module enforces (V6 §09): the *ledger* is the source of truth,
 * never the intent. We read the transaction's pre/post token balances and derive
 * the realised delta for the operator's own accounts. Anything we cannot prove
 * is reported as UNPROVEN and blocks new signing for that route rather than
 * being optimistically booked as profit.
 */

import type { Connection } from '@solana/web3.js';
import type { Logger } from '../../obs/src';
import type { SignedOutbox } from '../../journal/src';

export type ReconciliationVerdict = 'PROVEN_NET_POSITIVE' | 'PROVEN_NET_NON_POSITIVE' | 'UNPROVEN';

export interface ReconciliationResult {
  readonly verdict: ReconciliationVerdict;
  readonly signature: string;
  readonly realisedDeltaRaw: bigint | null;
  readonly feeLamports: bigint | null;
  readonly reason: string;
}

export class Reconciler {
  constructor(
    private readonly deps: {
      connection: Connection;
      journal: SignedOutbox;
      logger: Logger;
    },
  ) {}

  /**
   * Reconcile one intent by signature. `settlementMint` selects which token
   * balance movement is the P&L line.
   */
  async reconcileIntent(input: {
    intentId: string;
    routeKey: string;
    signature: string;
    settlementMint: string;
    ownerAddress: string;
  }): Promise<ReconciliationResult> {
    const { connection, journal, logger } = this.deps;

    const tx = await connection.getTransaction(input.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || !tx.transaction) {
      // No receipt: dropped, or older than this RPC's history window.
      logger.warn('reconcile_unproven', { intentId: input.intentId, signature: input.signature });
      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'SUBMITTED',
        signature: input.signature,
        payload: { reconciliation: 'UNPROVEN_NO_RECEIPT' },
      });
      return {
        verdict: 'UNPROVEN',
        signature: input.signature,
        realisedDeltaRaw: null,
        feeLamports: null,
        reason: 'no transaction receipt available',
      };
    }

    const feeLamports = BigInt(tx.meta.fee);

    if (tx.meta.err) {
      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'FAILED',
        signature: input.signature,
        payload: { reconciliation: 'ON_CHAIN_ERROR', fee: feeLamports.toString() },
      });
      return {
        verdict: 'PROVEN_NET_NON_POSITIVE',
        signature: input.signature,
        realisedDeltaRaw: 0n,
        feeLamports,
        reason: 'transaction reverted on chain; fee spent, no balance change',
      };
    }

    const pre = tx.meta.preTokenBalances ?? [];
    const post = tx.meta.postTokenBalances ?? [];

    // Guard: without balance data nothing can be proven.
    if (pre.length === 0 && post.length === 0) {
      journal.append({
        intentId: input.intentId,
        routeKey: input.routeKey,
        state: 'SUBMITTED',
        signature: input.signature,
        payload: { reconciliation: 'UNPROVEN_NO_BALANCE_DATA' },
      });
      return {
        verdict: 'UNPROVEN',
        signature: input.signature,
        realisedDeltaRaw: null,
        feeLamports,
        reason: 'receipt carries no token balance data',
      };
    }

    // `uiTokenAmount.amount` is already an integer base-unit string.
    const sumFor = (entries: typeof pre): bigint => {
      let total = 0n;
      for (const entry of entries) {
        if (entry.mint !== input.settlementMint) continue;
        if (entry.owner && entry.owner !== input.ownerAddress) continue;
        total += BigInt(entry.uiTokenAmount.amount);
      }
      return total;
    };

    const realisedDeltaRaw = sumFor(post) - sumFor(pre);
    const verdict: ReconciliationVerdict =
      realisedDeltaRaw > 0n ? 'PROVEN_NET_POSITIVE' : 'PROVEN_NET_NON_POSITIVE';

    journal.append({
      intentId: input.intentId,
      routeKey: input.routeKey,
      state: 'RECONCILED',
      signature: input.signature,
      payload: {
        reconciliation: verdict,
        realisedDeltaRaw: realisedDeltaRaw.toString(),
        feeLamports: feeLamports.toString(),
      },
    });
    logger.info('reconcile_complete', {
      intentId: input.intentId,
      verdict,
      realisedDeltaRaw: realisedDeltaRaw.toString(),
    });

    return { verdict, signature: input.signature, realisedDeltaRaw, feeLamports, reason: verdict };
  }

  /**
   * Resolve every intent left SIGNED/SUBMITTED by a previous process. This must
   * complete before new signing is enabled, otherwise the fee ledger is wrong.
   */
  async reconcilePending(input: {
    settlementMint: string;
    ownerAddress: string;
  }): Promise<ReconciliationResult[]> {
    const pending = this.deps.journal
      .unresolved()
      .filter((record) => record.signature !== null && record.state === 'SUBMITTED');

    const results: ReconciliationResult[] = [];
    for (const record of pending) {
      if (!record.signature) continue;
      results.push(
        await this.reconcileIntent({
          intentId: record.intentId,
          routeKey: record.routeKey,
          signature: record.signature,
          settlementMint: input.settlementMint,
          ownerAddress: input.ownerAddress,
        }),
      );
    }
    return results;
  }
}
