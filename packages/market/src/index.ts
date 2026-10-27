/**
 * packages/market — coherent pool state and the feed the execution layer reads.
 *
 * The core distinction this module enforces (V6 §10):
 *   "no data"  !=  "no opportunity"
 *
 * A pool whose last update is older than `maxQuoteAgeMs`, whose stream was
 * flagged as gapped, or whose two legs updated more than `maxSkewSlots` apart is
 * *incoherent*. Execution asks for a coherent pair and receives an explicit
 * reason when it cannot have one, so a stale feed can never be mistaken for a
 * thin market and quietly produce zero trades.
 */

import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import type { ReasonCode } from '../../domain/src';

export interface PairReadiness {
  readonly ready: boolean;
  readonly reason: ReasonCode;
  readonly detail: Record<string, unknown>;
}

export interface MarketFeedOptions {
  readonly maxQuoteAgeMs: number;
  /** Max slot difference allowed between the two legs of a route. */
  readonly maxSkewSlots: number;
  readonly nowUtc?: () => number;
}

export class MarketStateStore {
  private readonly byPool = new Map<string, PoolSnapshot>();
  private readonly invalidated = new Set<string>();
  private readonly maxQuoteAgeMs: number;
  private readonly maxSkewSlots: number;
  private readonly nowUtc: () => number;

  constructor(options: MarketFeedOptions) {
    this.maxQuoteAgeMs = options.maxQuoteAgeMs;
    this.maxSkewSlots = options.maxSkewSlots;
    this.nowUtc = options.nowUtc ?? (() => Date.now());
  }

  /** Apply a decoded snapshot. Older slots never overwrite newer state. */
  apply(snapshot: PoolSnapshot): { accepted: boolean; reason?: string } {
    const existing = this.byPool.get(snapshot.poolAddress);
    if (existing && existing.slot > snapshot.slot) {
      return { accepted: false, reason: 'OLDER_SLOT' };
    }
    this.byPool.set(snapshot.poolAddress, snapshot);
    this.invalidated.delete(snapshot.poolAddress);
    return { accepted: true };
  }

  /**
   * Mark a pool untrusted until fresh bytes arrive. Called when the transport
   * reports a gap or a resubscribe: cached state is unprovable afterwards.
   */
  invalidate(poolAddress: string, why: string): void {
    this.invalidated.add(poolAddress);
    const snapshot = this.byPool.get(poolAddress);
    if (snapshot) {
      this.byPool.set(poolAddress, {
        ...snapshot,
        coherence: 'DEGRADED',
        qualityFlags: [...new Set([...snapshot.qualityFlags, `INVALIDATED:${why}`])],
      });
    }
  }

  invalidateAll(why: string): void {
    for (const poolAddress of [...this.byPool.keys()]) this.invalidate(poolAddress, why);
  }

  get(poolAddress: string): PoolSnapshot | undefined {
    return this.byPool.get(poolAddress);
  }

  size(): number {
    return this.byPool.size;
  }

  /**
   * Whether two legs are simultaneously tradeable. This is the single gate the
   * execution path uses, and it returns the reason rather than a bare boolean so
   * the funnel stays explainable.
   */
  readiness(poolA: string, poolB: string): PairReadiness {
    const a = this.byPool.get(poolA);
    const b = this.byPool.get(poolB);

    if (!a || !b) {
      return {
        ready: false,
        reason: 'FEED_STALE',
        detail: { missing: [...(a ? [] : [poolA]), ...(b ? [] : [poolB])] },
      };
    }
    if (this.invalidated.has(poolA) || this.invalidated.has(poolB)) {
      return { ready: false, reason: 'FEED_GAP', detail: { pools: [poolA, poolB] } };
    }
    if (a.coherence !== 'COHERENT' || b.coherence !== 'COHERENT') {
      return {
        ready: false,
        reason: 'POLICY_OR_CODE_DRIFT',
        detail: { flagsA: a.qualityFlags, flagsB: b.qualityFlags },
      };
    }

    const now = this.nowUtc();
    const ageA = now - Date.parse(a.observedAtUtc);
    const ageB = now - Date.parse(b.observedAtUtc);
    if (ageA > this.maxQuoteAgeMs || ageB > this.maxQuoteAgeMs) {
      return {
        ready: false,
        reason: 'FEED_STALE',
        detail: { ageA, ageB, maxQuoteAgeMs: this.maxQuoteAgeMs },
      };
    }
    if (Math.abs(a.slot - b.slot) > this.maxSkewSlots) {
      return {
        ready: false,
        reason: 'FEED_GAP',
        detail: { slotA: a.slot, slotB: b.slot, maxSkewSlots: this.maxSkewSlots },
      };
    }
    return { ready: true, reason: 'OK', detail: { slotA: a.slot, slotB: b.slot } };
  }

  /** Observable freshness for /healthz and the operator dashboard. */
  ageMs(poolAddress: string): number | null {
    const snapshot = this.byPool.get(poolAddress);
    return snapshot ? this.nowUtc() - Date.parse(snapshot.observedAtUtc) : null;
  }

  snapshot(): Array<Record<string, unknown>> {
    return [...this.byPool.values()].map((p) => ({
      pool: p.poolAddress,
      slot: p.slot,
      tickIndex: p.tickIndex,
      liquidity: p.liquidityRaw.toString(),
      feeRatePpm: p.feeRatePpm,
      coherence: p.coherence,
      flags: p.qualityFlags,
      observedAtUtc: p.observedAtUtc,
      ageMs: this.ageMs(p.poolAddress),
    }));
  }
}
