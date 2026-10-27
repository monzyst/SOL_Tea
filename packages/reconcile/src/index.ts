/**
 * packages/reconcile — turn on-chain receipts into accounting truth.
 *
 * The rule: only a receipt that proves a balance delta may be booked as P&L.
 * Everything else is UNPROVEN, and an unproven route is blocked rather than
 * credited. Optimistic accounting is indistinguishable from a slow leak.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import type { Logger } from '../../obs/src';
import type { JournalRecord, SignedOutbox } from '../../journal/src';

export type ReconcileVerdict = 'PROVEN_NET_POSITIVE' | 'PROVEN_NET_NON_POSITIVE' | 'UNPROVEN';

export interface ReconciliationResult {
  readonly intentId: string;
  readonly signature: string | null;
  readonly verdict: ReconcileVerdict;
  readonly slot: number | null;
  readonly settlementDeltaRaw: bigint | null;
  readonly nativeFeeLamports: bigint | null;
  readonly detail: Record<string, unknown>;
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
   * Reconcile every unresolved intent. Intents without a signature are provably
   * not on chain; intents with one are looked up individually.
   */
  async reconcilePending(input: {
    settlementMint: string;
    ownerAddress: string;
  }): Promise<ReconciliationResult[]> {
    const pending = this.deps.journal.unresolved();
    const results: ReconciliationResult[] = [];

    for (const record of pending) {
      results.push(await this.reconcileRecord(record, input));
    }

    if (results.length > 0) {
      this.deps.logger.info('reconciliation_complete', {
        total: results.length,
        proven: results.filter((r) => r.verdict !== 'UNPROVEN').length,
        unproven: results.filter((r) => r.verdict === 'UNPROVEN').length,
      });
    }
    return results;
  }

  async reconcileRecord(
    record: JournalRecord,
    input: { settlementMint: string; ownerAddress: string },
  ): Promise<ReconciliationResult> {
    const { connection, journal, logger } = this.deps;

    if (!record.signature) {
      // No signature was ever produced: nothing can be on chain.
      journal.append({
        intentId: record.intentId,
        routeKey: record.routeKey,
        state: 'NOT_SENT',
        payload: { reconciledAt: new Date().toISOString(), reason: 'no-signature' },
      });
      return {
        intentId: record.intentId,
        signature: null,
        verdict: 'UNPROVEN',
        slot: null,
        settlementDeltaRaw: null,
        nativeFeeLamports: null,
        detail: { reason: 'no-signature' },
      };
    }

    try {
      const status = await connection.getSignatureStatus(record.signature, {
        searchTransactionHistory: true,
      });
      const value = status.value;

      if (!value) {
        // Absent from history. That is not proof of failure — history is finite —
        // so this stays UNPROVEN and the route stays blocked.
        logger.warn('reconcile_signature_not_found', {
          intentId: record.intentId,
          signature: record.signature,
        });
        return {
          intentId: record.intentId,
          signature: record.signature,
          verdict: 'UNPROVEN',
          slot: null,
          settlementDeltaRaw: null,
          nativeFeeLamports: null,
          detail: { reason: 'signature-not-found' },
        };
      }

      if (value.err) {
        journal.append({
          intentId: record.intentId,
          routeKey: record.routeKey,
          state: 'REVERTED',
          signature: record.signature,
          payload: { slot: value.slot, error: JSON.stringify(value.err), reconciled: true },
        });
        return {
          intentId: record.intentId,
          signature: record.signature,
          verdict: 'PROVEN_NET_NON_POSITIVE',
          slot: value.slot,
          settlementDeltaRaw: null,
          nativeFeeLamports: 5_000n,
          detail: { error: JSON.stringify(value.err) },
        };
      }

      // Landed successfully: compute the settlement delta from balance changes.
      const delta = await this.settlementDelta({
        signature: record.signature,
        settlementMint: input.settlementMint,
        ownerAddress: input.ownerAddress,
      });

      if (delta === null) {
        // Included but unprovable from this receipt: blocked, not booked.
        journal.append({
          intentId: record.intentId,
          routeKey: record.routeKey,
          state: 'INCLUDED',
          signature: record.signature,
          payload: { slot: value.slot, reconciled: false, reason: 'no-balance-data' },
        });
        return {
          intentId: record.intentId,
          signature: record.signature,
          verdict: 'UNPROVEN',
          slot: value.slot,
          settlementDeltaRaw: null,
          nativeFeeLamports: null,
          detail: { reason: 'no-balance-data' },
        };
      }

      journal.append({
        intentId: record.intentId,
        routeKey: record.routeKey,
        state: 'INCLUDED',
        signature: record.signature,
        payload: { slot: value.slot, settlementDeltaRaw: delta.toString(), reconciled: true },
      });

      return {
        intentId: record.intentId,
        signature: record.signature,
        verdict: delta > 0n ? 'PROVEN_NET_POSITIVE' : 'PROVEN_NET_NON_POSITIVE',
        slot: value.slot,
        settlementDeltaRaw: delta,
        nativeFeeLamports: 5_000n,
        detail: { reconciled: true },
      };
    } catch (error) {
      logger.error('reconcile_failed', {
        intentId: record.intentId,
        signature: record.signature,
        error: (error as Error).message,
      });
      return {
        intentId: record.intentId,
        signature: record.signature,
        verdict: 'UNPROVEN',
        slot: null,
        settlementDeltaRaw: null,
        nativeFeeLamports: null,
        detail: { error: (error as Error).message },
      };
    }
  }

  /**
   * Settlement-token delta for the owner, derived from pre/post token balances.
   * Returns null when the receipt does not carry the accounts we need.
   */
  private async settlementDelta(input: {
    signature: string;
    settlementMint: string;
    ownerAddress: string;
  }): Promise<bigint | null> {
    const transaction = await this.deps.connection.getTransaction(input.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.meta) return null;

    const owner = new PublicKey(input.ownerAddress);
    const mint = new PublicKey(input.settlementMint);
    const keys = transaction.transaction.message.staticAccountKeys;

    let delta = 0n;
    let matched = 0;

    for (const balance of transaction.meta.postTokenBalances ?? []) {
      if (balance.mint !== mint.toBase58() || balance.owner !== owner.toBase58()) continue;
      const pre = transaction.meta.preTokenBalances?.find(
        (candidate) => candidate.accountIndex === balance.accountIndex,
      );
      const post = BigInt(Number(balance.uiTokenAmount.amount));
      const before = pre ? BigInt(Number(pre.uiTokenAmount.amount)) : 0n;
      delta += post - before;
      matched += 1;
    }

    if (matched === 0) return null;
    // Static keys are intentionally unused here; referenced to keep the
    // dependency explicit if a future version needs them for attribution.
    void keys;
    return delta;
  }
}
