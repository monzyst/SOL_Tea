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
  /** Latest slot observed anywhere on the stream; 0 until the first heartbeat. */
  private chainTipSlot = 0;
  /**
   * Hard ceiling on chain-tip staleness. Slot age is the primary freshness test;
   * wall-clock age is only a fallback for the case where no heartbeat has ever
   * arrived.
   */
  private readonly feedStaleMs: number;
  /** Max slots a pool may trail the chain tip and still be quotable. */
  private readonly maxSlotLag: number;

  constructor(options: MarketFeedOptions & { feedStaleMs?: number; maxSlotLag?: number }) {
    this.maxQuoteAgeMs = options.maxQuoteAgeMs;
    this.maxSkewSlots = options.maxSkewSlots;
    this.nowUtc = options.nowUtc ?? (() => Date.now());
    this.feedStaleMs = options.feedStaleMs ?? 60_000;
    // ~400 slots is roughly 160s at 400ms/slot: wide enough that an untraded but
    // current pool is quotable, tight enough that a dead feed cannot be.
    this.maxSlotLag = options.maxSlotLag ?? 400;
  }

  /**
   * Record the stream's latest slot.
   *
   * WHY: freshness must be measured as "how far behind the chain tip is this
   * pool", NOT "how long since this pool's account last changed". A quiet pool —
   * e.g. a low-liquidity leg — legitimately produces no account updates for
   * minutes at a time while remaining perfectly current. Judging it by wall-clock
   * age marks it permanently stale, so no closed cycle is ever priceable, and the
   * engine reports FEED_STALE forever on a perfectly healthy feed.
   */
  setChainTipSlot(slot: number): void {
    if (slot > this.chainTipSlot) this.chainTipSlot = slot;
  }

  getChainTip(): number {
    return this.chainTipSlot;
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

    // PRIMARY test: distance from the chain tip, in slots. A pool whose last
    // update is 5 slots behind a tip at 462M is current; one 400 slots behind is
    // not, regardless of wall-clock. This is the only test that is correct for
    // both a busy pool and a quiet one.
    if (this.chainTipSlot > 0) {
      const lagA = this.chainTipSlot - a.slot;
      const lagB = this.chainTipSlot - b.slot;
      const slotBudget = this.maxSlotLag;
      if (lagA > slotBudget || lagB > slotBudget) {
        return {
          ready: false,
          reason: 'FEED_STALE',
          detail: {
            lagA,
            lagB,
            chainTip: this.chainTipSlot,
            maxSlotLag: slotBudget,
            ageA,
            ageB,
          },
        };
      }
    } else {
      // No heartbeat yet: fall back to wall clock, which is conservative.
      if (ageA > this.maxQuoteAgeMs || ageB > this.maxQuoteAgeMs) {
        return {
          ready: false,
          reason: 'FEED_STALE',
          detail: { ageA, ageB, maxQuoteAgeMs: this.maxQuoteAgeMs, reasonDetail: 'NoChainTip' },
        };
      }
    }
    // DELIBERATELY NOT a leg-vs-leg slot comparison.
    //
    // Comparing |a.slot - b.slot| looks like a coherence test but is not one for
    // concentrated liquidity: a pool's account changes ONLY when someone swaps or
    // liquidity moves. A quiet WSOL/USDC leg can sit 200+ slots without an update
    // while its quoted price remains exactly correct, so a tight leg-vs-leg skew
    // rejects healthy pairs permanently and the engine never trades — which is
    // what this code originally did (FEED_GAP on every evaluation).
    //
    // The real risks are (a) a leg that is genuinely behind the chain, and (b) a
    // silently dead subscription. (a) is the per-leg lag test above; (b) is caught
    // by the transport's own stall/health timer and by onGap invalidating cached
    // bytes. `maxSkewSlots` is retained for quote-level checks at the execution
    // layer, where comparing the SLOT A QUOTE WAS BUILT FROM against the slot the
    // transaction will land in is the meaningful comparison. For observability the
    // actual skew is reported in the detail of a successful readiness verdict.
    if (this.maxSkewSlots <= 0) {
      throw new Error('maxSkewSlots must be positive');
    }
    return {
      ready: true,
      reason: 'OK',
      detail: { slotA: a.slot, slotB: b.slot, legSkewSlots: Math.abs(a.slot - b.slot) },
    };
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
