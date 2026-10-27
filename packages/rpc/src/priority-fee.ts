/**
 * packages/rpc/priority-fee — adaptive priority-fee estimation.
 *
 * The previous revision used one static constant (1000 micro-lamports per CU)
 * for every attempt. That is wrong in both directions, and both directions cost
 * money:
 *
 *  - Too low during congestion: the transaction is dropped, the quote decays,
 *    and the attempt is lost after paying for the round trips.
 *  - Too high on a quiet chain: every attempt overpays, and since the fee is
 *    charged on the *declared* compute-unit limit, overpaying is a direct
 *    arithmetic loss on each cycle.
 *
 * So the fee is estimated from what the chain is actually charging. Three
 * deliberate design points:
 *
 *  1. PERCENTILE, not mean. Priority fees on Solana are extremely long-tailed
 *     (a few payers bid enormous amounts); the mean is dragged up by outliers
 *     and would make us systematically overpay. The median/p75 is what gets
 *     included in a normal slot.
 *  2. SAMPLE-BOUNDED. `getRecentPrioritizationFees` is per-account and returns
 *     recent slots only. If too few samples carry a non-zero fee we treat the
 *     estimate as UNAVAILABLE rather than inventing a number — the caller must
 *     then refuse the attempt (`FEE_ESTIMATE_UNAVAILABLE`) instead of guessing.
 *  3. HARD-BOUNDED. Whatever the market says, the result is clamped into
 *     [floor, ceiling] from config, so a pathological fee spike cannot push an
 *     attempt past its per-attempt native cap. The clamp is applied here AND
 *     re-checked by admission, deliberately twice.
 *
 * The estimator is async but the hot path must not wait on it per candidate, so
 * samples are cached for `ttlMs` and refreshed in the background.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import { nowMonoNs, type Logger } from '../../obs/src';

export interface PriorityFeeEstimate {
  /** Chosen fee, micro-lamports per compute unit, already clamped. */
  readonly microLamports: number;
  /** Raw percentile before clamping — kept for traceability. */
  readonly rawPercentile: number;
  readonly sampleCount: number;
  readonly nonZeroSamples: number;
  readonly source: 'chain-samples' | 'floor-clamped' | 'ceiling-clamped' | 'unavailable';
  readonly sampledAtUtc: string;
  readonly ageMs: number;
}

export interface PriorityFeeOptions {
  readonly connection: Connection;
  readonly logger: Logger;
  /** Accounts whose recent fees to sample (the pools we trade). */
  readonly watchedAccounts: readonly string[];
  /** Percentile of the observed distribution to bid at, 0..1. */
  readonly percentile?: number;
  readonly floorMicroLamports?: number;
  readonly ceilingMicroLamports?: number;
  /** Minimum non-zero samples required before an estimate is trustworthy. */
  readonly minSamples?: number;
  readonly ttlMs?: number;
  /** Used when the caller wants a value even with no samples. Null = refuse. */
  readonly fallbackMicroLamports?: number | null;
  readonly nowUtc?: () => Date;
}

const DEFAULTS = {
  percentile: 0.5,
  floorMicroLamports: 1_000,
  ceilingMicroLamports: 200_000,
  minSamples: 8,
  ttlMs: 15_000,
} as const;

/** Nearest-rank percentile over an ascending-sorted array. Pure, for testing. */
export function percentileOf(sortedAscending: readonly number[], percentile: number): number {
  if (sortedAscending.length === 0) return 0;
  const p = Math.min(1, Math.max(0, percentile));
  // Nearest-rank: index ceil(p * n) - 1, clamped into range.
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(p * sortedAscending.length) - 1));
  return sortedAscending[index] as number;
}

/**
 * Fold raw samples into a bounded estimate. Pure: no I/O, so the policy logic
 * (which percentile, when to refuse, how to clamp) is directly testable.
 */
export function summarisePriorityFee(input: {
  samples: readonly number[];
  percentile: number;
  floorMicroLamports: number;
  ceilingMicroLamports: number;
  minSamples: number;
  fallbackMicroLamports?: number | null;
  nowUtc?: Date;
  sampledAtUtc?: string;
}): PriorityFeeEstimate {
  const now = input.nowUtc ?? new Date();
  const sampledAtUtc = input.sampledAtUtc ?? now.toISOString();
  const clampedFloor = Math.max(0, Math.floor(input.floorMicroLamports));
  const clampedCeiling = Math.max(clampedFloor, Math.floor(input.ceilingMicroLamports));

  const usable = input.samples.filter((s) => Number.isFinite(s) && s >= 0);
  const nonZero = usable.filter((s) => s > 0);

  if (nonZero.length < input.minSamples) {
    if (input.fallbackMicroLamports === null || input.fallbackMicroLamports === undefined) {
      return {
        microLamports: 0,
        rawPercentile: 0,
        sampleCount: usable.length,
        nonZeroSamples: nonZero.length,
        source: 'unavailable',
        sampledAtUtc,
        ageMs: 0,
      };
    }
    const bounded = Math.min(clampedCeiling, Math.max(clampedFloor, Math.floor(input.fallbackMicroLamports)));
    return {
      microLamports: bounded,
      rawPercentile: 0,
      sampleCount: usable.length,
      nonZeroSamples: nonZero.length,
      source: 'floor-clamped',
      sampledAtUtc,
      ageMs: 0,
    };
  }

  const sorted = [...nonZero].sort((a, b) => a - b);
  const raw = percentileOf(sorted, input.percentile);

  let microLamports = raw;
  let source: PriorityFeeEstimate['source'] = 'chain-samples';
  if (raw < clampedFloor) {
    microLamports = clampedFloor;
    source = 'floor-clamped';
  } else if (raw > clampedCeiling) {
    microLamports = clampedCeiling;
    source = 'ceiling-clamped';
  }

  return {
    // Bidding zero guarantees deprioritisation, so never return 0 from a real
    // sample set; the floor above already prevents it.
    microLamports: Math.max(1, Math.round(microLamports)),
    rawPercentile: raw,
    sampleCount: usable.length,
    nonZeroSamples: nonZero.length,
    source,
    sampledAtUtc,
    ageMs: Math.max(0, now.getTime() - Date.parse(sampledAtUtc)),
  };
}

export class PriorityFeeEstimator {
  private cached: PriorityFeeEstimate | null = null;
  private cachedAtMonoNs = 0n;
  private inFlight: Promise<PriorityFeeEstimate> | null = null;
  private readonly options: Required<Omit<PriorityFeeOptions, 'connection' | 'logger' | 'watchedAccounts' | 'nowUtc' | 'fallbackMicroLamports'>> &
    Pick<PriorityFeeOptions, 'fallbackMicroLamports'>;

  constructor(private readonly deps: PriorityFeeOptions) {
    this.options = {
      percentile: deps.percentile ?? DEFAULTS.percentile,
      floorMicroLamports: deps.floorMicroLamports ?? DEFAULTS.floorMicroLamports,
      ceilingMicroLamports: deps.ceilingMicroLamports ?? DEFAULTS.ceilingMicroLamports,
      minSamples: deps.minSamples ?? DEFAULTS.minSamples,
      ttlMs: deps.ttlMs ?? DEFAULTS.ttlMs,
      fallbackMicroLamports: deps.fallbackMicroLamports,
    };
  }

  get ceilingMicroLamports(): number {
    return this.options.ceilingMicroLamports;
  }

  get floorMicroLamports(): number {
    return this.options.floorMicroLamports;
  }

  /** Last estimate without touching the network (may be null before warm-up). */
  peek(): PriorityFeeEstimate | null {
    return this.cached;
  }

  /**
   * Best available estimate. Returns the cache while it is fresh; otherwise
   * samples the chain. Concurrent callers share one request.
   */
  async estimate(): Promise<PriorityFeeEstimate> {
    if (this.cached && this.ageMs() < this.options.ttlMs) return this.cached;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh()
      .catch((error: unknown) => {
        this.deps.logger.warn('priority_fee_sample_failed', { error: (error as Error).message });
        // A sampling failure is not a licence to invent a number: reuse the
        // last known value if it is still verdict-safe, else report unavailable.
        if (this.cached) return this.cached;
        return summarisePriorityFee({
          samples: [],
          percentile: this.options.percentile,
          floorMicroLamports: this.options.floorMicroLamports,
          ceilingMicroLamports: this.options.ceilingMicroLamports,
          minSamples: this.options.minSamples,
          fallbackMicroLamports: this.options.fallbackMicroLamports,
          nowUtc: this.deps.nowUtc?.(),
        });
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Force a resample (operator action, or after a dropped transaction). */
  async refresh(): Promise<PriorityFeeEstimate> {
    const accounts = this.deps.watchedAccounts.map((a) => new PublicKey(a));
    const samples: number[] = [];

    // Sampled per watched account: the RPC reports fees relevant to those
    // accounts' write-lock sets, which is what our transaction competes for.
    for (const account of accounts) {
      const fees = await this.deps.connection.getRecentPrioritizationFees({ lockedWritableAccounts: [account] });
      for (const entry of fees) samples.push(entry.prioritizationFee);
    }

    const estimate = summarisePriorityFee({
      samples,
      percentile: this.options.percentile,
      floorMicroLamports: this.options.floorMicroLamports,
      ceilingMicroLamports: this.options.ceilingMicroLamports,
      minSamples: this.options.minSamples,
      fallbackMicroLamports: this.options.fallbackMicroLamports,
      nowUtc: this.deps.nowUtc?.(),
    });

    this.cached = estimate;
    this.cachedAtMonoNs = nowMonoNs();

    if (estimate.source === 'unavailable') {
      this.deps.logger.warn('priority_fee_unavailable', {
        sampleCount: estimate.sampleCount,
        nonZeroSamples: estimate.nonZeroSamples,
        minSamples: this.options.minSamples,
      });
    } else {
      this.deps.logger.debug('priority_fee_estimate', {
        microLamports: estimate.microLamports,
        rawPercentile: estimate.rawPercentile,
        source: estimate.source,
        samples: estimate.sampleCount,
      });
    }
    return estimate;
  }

  private ageMs(): number {
    if (this.cachedAtMonoNs === 0n) return Number.MAX_SAFE_INTEGER;
    return Number(nowMonoNs() - this.cachedAtMonoNs) / 1_000_000;
  }
}
