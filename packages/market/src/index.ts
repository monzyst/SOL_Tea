/**
 * packages/market — coherent pool state and the feed the execution layer reads.
 *
 * The central idea: state is *coherent* or it is not usable. An update older than
 * `maxQuoteAgeMs`, a pool whose legs are further apart than `maxSkewSlots`, or a
 * pool flagged DEGRADED are all refused with a reason code. Refusing is cheap;
 * trading on a torn view is not.
 *
 * Nothing here does I/O — it is a store, so it stays fast and testable.
 */

import type { ReasonCode } from '../../domain/src';
import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import { nowMonoNs } from '../../obs/src';

export interface MarketStateOptions {
  /** A snapshot older than this may not be quoted against. */
  readonly maxQuoteAgeMs: number;
  /** Two legs must be within this many slots to be treated as simultaneous. */
  readonly maxSkewSlots: number;
  readonly nowMonoNs?: () => bigint;
}

export interface ApplyResult {
  readonly accepted: boolean;
  readonly reason: string | null;
}

export interface Readiness {
  readonly ready: boolean;
  readonly reason: ReasonCode;
  readonly detail: Record<string, unknown>;
}

export interface PoolStateView {
  readonly pool: string;
  readonly slot: number;
  readonly coherence: 'COHERENT' | 'DEGRADED';
  readonly ageMs: number | null;
  readonly liquidity: string;
  readonly tickIndex: number;
  readonly reserveA: string | null;
  readonly reserveB: string | null;
  readonly invalidatedBy: string | null;
}

export class MarketStateStore {
  private readonly states = new Map<string, PoolSnapshot>();
  private readonly invalidations = new Map<string, string>();
  private readonly nowMono: () => bigint;

  constructor(private readonly options: MarketStateOptions) {
    if (options.maxQuoteAgeMs <= 0) throw new Error('maxQuoteAgeMs must be positive');
    if (options.maxSkewSlots < 0) throw new Error('maxSkewSlots cannot be negative');
    this.nowMono = options.nowMonoNs ?? nowMonoNs;
  }

  /**
   * Apply a snapshot. Out-of-order updates are dropped: an older slot must never
   * overwrite a newer one, or a delayed packet silently rewinds the feed.
   */
  apply(snapshot: PoolSnapshot): ApplyResult {
    const existing = this.states.get(snapshot.poolAddress);
    if (existing && snapshot.slot < existing.slot) {
      return { accepted: false, reason: 'OUT_OF_ORDER' };
    }
    this.states.set(snapshot.poolAddress, snapshot);
    // A good update lifts a decode/gap invalidation.
    this.invalidations.delete(snapshot.poolAddress);
    return { accepted: true, reason: null };
  }

  /** Mark a pool untrusted until its next good update. */
  invalidate(poolAddress: string, reason: string): void {
    this.invalidations.set(poolAddress, reason);
  }

  /**
   * After a stream gap, no cached bytes can be proven contiguous, so every
   * pool is quarantined. They re-enter service as fresh updates arrive.
   */
  invalidateAll(reason: string): void {
    for (const poolAddress of this.states.keys()) this.invalidations.set(poolAddress, reason);
  }

  get(poolAddress: string): PoolSnapshot | undefined {
    return this.states.get(poolAddress);
  }

  ageMs(poolAddress: string): number | null {
    const snapshot = this.states.get(poolAddress);
    if (!snapshot) return null;
    return Number(this.nowMono() - snapshot.observedMonoNs) / 1_000_000;
  }

  /**
   * Decide whether a PAIR may be traded together. Ordered so the reported reason
   * is the first real blocker: quarantine, then coherence, then freshness, then
   * skew between the two legs.
   */
  readiness(poolA: string, poolB: string): Readiness {
    for (const pool of [poolA, poolB]) {
      const invalidation = this.invalidations.get(pool);
      if (invalidation) {
        return {
          ready: false,
          reason: invalidation === 'DECODE_ERROR' ? 'POOL_DEGRADED' : 'FEED_GAP',
          detail: { pool, cause: invalidation },
        };
      }
      const snapshot = this.states.get(pool);
      if (!snapshot) return { ready: false, reason: 'FEED_STALE', detail: { pool, cause: 'NO_DATA' } };
      if (snapshot.coherence !== 'COHERENT') {
        return {
          ready: false,
          reason: 'POOL_DEGRADED',
          detail: { pool, flags: snapshot.qualityFlags },
        };
      }
      const age = this.ageMs(pool);
      if (age === null || age > this.options.maxQuoteAgeMs) {
        return {
          ready: false,
          reason: 'FEED_STALE',
          detail: { pool, ageMs: age === null ? null : Math.round(age) },
        };
      }
    }

    const a = this.states.get(poolA) as PoolSnapshot;
    const b = this.states.get(poolB) as PoolSnapshot;
    const skew = Math.abs(a.slot - b.slot);
    if (skew > this.options.maxSkewSlots) {
      return { ready: false, reason: 'FEED_GAP', detail: { skewSlots: skew } };
    }

    return { ready: true, reason: 'OK', detail: { skewSlots: skew } };
  }

  snapshot(): PoolStateView[] {
    return [...this.states.values()].map((snapshot) => ({
      pool: snapshot.poolAddress,
      slot: snapshot.slot,
      coherence: snapshot.coherence,
      ageMs: this.ageMs(snapshot.poolAddress),
      liquidity: snapshot.liquidityRaw.toString(),
      tickIndex: snapshot.tickIndex,
      reserveA: snapshot.reserveA?.toString() ?? null,
      reserveB: snapshot.reserveB?.toString() ?? null,
      invalidatedBy: this.invalidations.get(snapshot.poolAddress) ?? null,
    }));
  }
}
