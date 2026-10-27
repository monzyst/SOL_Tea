/**
 * chains/solana/src/clmm — concentrated-liquidity math and the liquidity map.
 *
 * Why this module exists. The discovery path used to price every pool with a
 * constant-product formula over vault totals, which is wrong for a Whirlpool in
 * two distinct ways:
 *
 *   1. It ignores that liquidity is only active inside the current tick range,
 *      so it systematically overstates depth near the edges of a range.
 *   2. It silently assumes constant liquidity all the way to the output, so a
 *      quote can pass straight through a boundary where liquidity changes while
 *      still using the old number. (This is the same class of defect the source
 *      review flagged as Z2-05 in the other implementation.)
 *
 * The fix is to walk the *real* initialized ticks. Two deliberate choices:
 *
 *  - Tick/price conversion DELEGATES to the pinned Orca SDK (PriceMath). The
 *    other implementation hand-copied a truncated constant table and produced
 *    wrong prices for ordinary ranges (Z2-04). Re-deriving canonical constants
 *    by hand is a losing game; using the library the program itself was written
 *    against is not.
 *  - The liquidity walk here is exact integer math (no floats), with explicit
 *    rounding direction, because a quote that rounds in the trader's favour is
 *    a quote that reverts.
 *
 * Everything is pure: no I/O, no clock, fully unit-testable against an oracle.
 */

import BN from 'bn.js';
import { PriceMath } from '@orca-so/whirlpools-sdk';
import { mulDivCeil, mulDivFloor } from '../../../packages/domain/src';

/** Q64.64 fixed-point denominator. */
export const Q64 = 1n << 64n;

/** Whirlpool program limits (see MAX_TICK_INDEX/MIN_TICK_INDEX in the SDK). */
export const MIN_TICK_INDEX = -443_636;
export const MAX_TICK_INDEX = 443_636;
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;

/** Convert a tick index to its sqrt price (Q64.64), canonically. */
export function sqrtPriceX64AtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK_INDEX || tick > MAX_TICK_INDEX) {
    throw new RangeError(`tick ${tick} is outside [${MIN_TICK_INDEX}, ${MAX_TICK_INDEX}]`);
  }
  return BigInt(PriceMath.tickIndexToSqrtPriceX64(tick).toString());
}

/** Convert a sqrt price (Q64.64) to the tick index that contains it. */
export function tickAtSqrtPriceX64(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE || sqrtPriceX64 > MAX_SQRT_PRICE) {
    throw new RangeError(`sqrtPrice ${sqrtPriceX64} is outside the supported range`);
  }
  return PriceMath.sqrtPriceX64ToTickIndex(new BN(sqrtPriceX64.toString()));
}

/** Token A (token0) delta between two sqrt prices for a given liquidity. */
export function amountADelta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (hi === lo || liquidity === 0n) return 0n;
  const numerator1 = liquidity << 64n;
  const numerator2 = hi - lo;
  // Δx = L·(√Pb − √Pa)/√Pb · 1/√Pa, in Q64 fixed point.
  const step = (numerator1 * numerator2) / hi;
  return roundUp ? mulDivCeil(step, 1n, lo) : step / lo;
}

/** Token B (token1) delta between two sqrt prices for a given liquidity. */
export function amountBDelta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (hi === lo || liquidity === 0n) return 0n;
  const delta = hi - lo;
  // Δy = L·Δ√P / 2^64. NOTE: no `L << 64` here — the Q64 scale belongs to the
  // sqrt prices, so Δ√P is already Q64-scaled and dividing by Q64 once is
  // exact. An earlier revision shifted L left by 64 and divided by Q64 too,
  // which cancelled out and overstated every B-side delta by 2^64 (caught by
  // tests/unit/clmm.test.ts against the SDK oracle).
  const product = liquidity * delta;
  return roundUp ? mulDivCeil(product, 1n, Q64) : product / Q64;
}

/** One initialized tick discovered on chain, with its net liquidity change. */
export interface InitializedTick {
  readonly tickIndex: number;
  /** Liquidity added when price crosses this tick upward. */
  readonly liquidityNet: bigint;
  readonly liquidityGross: bigint;
}

/**
 * An ordered view of the initialized ticks around a position.
 *
 * `liquidityAt(tick)` resolves active liquidity by walking from the pool's own
 * `liquidity` field (already the active value at `referenceTick`) and applying
 * net deltas. Resolving from the pool's own number rather than accumulating
 * from zero is what keeps this correct even when the loaded arrays do not reach
 * the pool's range limits.
 */
export class LiquidityMap {
  private readonly ticks: InitializedTick[];
  private readonly liquidityAtReferenceTick: bigint;
  private readonly referenceTick: number;

  constructor(input: {
    ticks: readonly InitializedTick[];
    /** Pool `liquidity` field — the active liquidity at `referenceTick`. */
    liquidityAtReference: bigint;
    referenceTick: number;
  }) {
    const sorted = [...input.ticks].sort((a, b) => a.tickIndex - b.tickIndex);
    const seen = new Set<number>();
    for (const tick of sorted) {
      if (seen.has(tick.tickIndex)) throw new Error(`duplicate initialized tick ${tick.tickIndex}`);
      seen.add(tick.tickIndex);
    }
    this.ticks = sorted;
    this.liquidityAtReferenceTick = input.liquidityAtReference;
    this.referenceTick = input.referenceTick;
  }

  get size(): number {
    return this.ticks.length;
  }

  get all(): readonly InitializedTick[] {
    return this.ticks;
  }

  /** Lowest / highest tick covered by this map (the trust boundary). */
  get minTick(): number {
    return this.ticks.length === 0 ? this.referenceTick : (this.ticks[0] as InitializedTick).tickIndex;
  }

  get maxTick(): number {
    return this.ticks.length === 0
      ? this.referenceTick
      : (this.ticks[this.ticks.length - 1] as InitializedTick).tickIndex;
  }

  /** Active liquidity at `tick`, resolved by walking from the reference tick. */
  liquidityAt(tick: number): bigint {
    let liquidity = this.liquidityAtReferenceTick;
    if (tick > this.referenceTick) {
      for (const entry of this.ticks) {
        if (entry.tickIndex > this.referenceTick && entry.tickIndex <= tick) {
          liquidity += entry.liquidityNet;
        }
      }
      return liquidity;
    }
    for (const entry of this.ticks) {
      if (entry.tickIndex > tick && entry.tickIndex <= this.referenceTick) {
        liquidity -= entry.liquidityNet;
      }
    }
    return liquidity;
  }

  /** Whether the map can prove state as far as `tick`. */
  covers(tick: number): boolean {
    return tick >= this.minTick && tick <= this.maxTick;
  }

  /**
   * The first initialized tick boundary strictly beyond `from` in the direction
   * of travel — the point at which liquidity CHANGES.
   *
   * This is the function whose absence caused the boundary bug: a naive
   * `tick - (tick % spacing) - spacing` skips a real boundary at, e.g., tick 10
   * when starting from 15, then quotes as if liquidity were constant across a
   * change that definitely happens.
   */
  firstBoundaryBeyond(from: number, aToB: boolean): number | null {
    if (aToB) {
      for (let i = this.ticks.length - 1; i >= 0; i -= 1) {
        const entry = this.ticks[i] as InitializedTick;
        if (entry.tickIndex <= from) return entry.tickIndex;
      }
      return null;
    }
    for (const entry of this.ticks) {
      if (entry.tickIndex > from) return entry.tickIndex;
    }
    return null;
  }
}

export type WalkRefusal = 'LIQUIDITY_UNREFERENCED' | 'ZERO_LIQUIDITY' | 'PRICE_LIMIT' | 'AMOUNT_TOO_LARGE';

export interface WalkStep {
  readonly fromTick: number;
  readonly toTick: number;
  readonly liquidity: bigint;
  readonly sqrtPriceFrom: bigint;
  readonly sqrtPriceTo: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly final: boolean;
}

export interface WalkResult {
  readonly ok: boolean;
  readonly refusal: WalkRefusal | null;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly endSqrtPriceX64: bigint;
  readonly endTick: number;
  readonly steps: readonly WalkStep[];
  readonly boundariesCrossed: number;
  /** Fee deducted from the input, already excluded from amountOut. */
  readonly feeAmount: bigint;
}

/**
 * Exact-input walk across initialized liquidity.
 *
 * Continues until the input is consumed or the walk would leave the proven
 * region of the map — in which case it REFUSES rather than extrapolating.
 * A refusal is a correct answer: "I cannot price this size honestly" is
 * strictly better than a number that looks profitable and reverts.
 */
export function walkExactIn(input: {
  amountIn: bigint;
  sqrtPriceX64: bigint;
  tickIndex: number;
  liquidityMap: LiquidityMap;
  feeRatePpm: number;
  aToB: boolean;
  /** Optional hard price limit; the walk may not move beyond it. */
  sqrtPriceLimit?: bigint;
}): WalkResult {
  const { amountIn, liquidityMap, feeRatePpm, aToB } = input;
  const feeDenominator = 1_000_000n;
  const feePpm = BigInt(Math.max(0, Math.min(100_000, feeRatePpm)));

  const refuse = (refusal: WalkRefusal): WalkResult => ({
    ok: false,
    refusal,
    amountIn,
    amountOut: 0n,
    endSqrtPriceX64: input.sqrtPriceX64,
    endTick: input.tickIndex,
    steps: [],
    boundariesCrossed: 0,
    feeAmount: 0n,
  });

  if (amountIn <= 0n) return refuse('AMOUNT_TOO_LARGE');

  const priceLimit = input.sqrtPriceLimit ?? (aToB ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n);

  let sqrtPrice = input.sqrtPriceX64;
  let tick = input.tickIndex;
  let remaining = amountIn;
  let amountOut = 0n;
  let feeTotal = 0n;
  let boundariesCrossed = 0;
  const steps: WalkStep[] = [];
  const maxSteps = liquidityMap.size + 4;

  for (let step = 0; step < maxSteps; step += 1) {
    if (remaining <= 0n) break;

    const liquidity = liquidityMap.liquidityAt(tick);
    if (liquidity <= 0n) {
      // Distinguish "nothing here at entry" from "the size exhausted every loaded
      // range". Both refuse, but the reason codes drive different operator
      // actions: ZERO_LIQUIDITY is a bad/stale map, AMOUNT_TOO_LARGE is a size cap.
      return refuse(steps.length === 0 ? 'ZERO_LIQUIDITY' : 'AMOUNT_TOO_LARGE');
    }

    const boundary = liquidityMap.firstBoundaryBeyond(tick, aToB);
    // With no boundary ahead, the only honest end point is the program's range
    // limit — and only if the map actually proves liquidity out to there.
    if (boundary === null && !liquidityMap.covers(aToB ? MIN_TICK_INDEX : MAX_TICK_INDEX)) {
      return refuse('LIQUIDITY_UNREFERENCED');
    }
    const segmentEndTick = boundary ?? (aToB ? MIN_TICK_INDEX : MAX_TICK_INDEX);

    let targetSqrt = sqrtPriceX64AtTickClamped(segmentEndTick);
    if (aToB && targetSqrt < priceLimit) targetSqrt = priceLimit;
    if (!aToB && targetSqrt > priceLimit) targetSqrt = priceLimit;

    const netForSegment = aToB
      ? amountADelta(sqrtPrice, targetSqrt, liquidity, true)
      : amountBDelta(sqrtPrice, targetSqrt, liquidity, true);
    const neededWithFee =
      feePpm === 0n ? netForSegment : mulDivCeil(netForSegment, feeDenominator, feeDenominator - feePpm);

    if (remaining >= neededWithFee && neededWithFee > 0n) {
      const outForSegment = aToB
        ? amountBDelta(sqrtPrice, targetSqrt, liquidity, false)
        : amountADelta(sqrtPrice, targetSqrt, liquidity, false);
      steps.push({
        fromTick: tick,
        toTick: segmentEndTick,
        liquidity,
        sqrtPriceFrom: sqrtPrice,
        sqrtPriceTo: targetSqrt,
        amountIn: neededWithFee,
        amountOut: outForSegment,
        final: false,
      });
      remaining -= neededWithFee;
      feeTotal += neededWithFee - netForSegment;
      amountOut += outForSegment;
      sqrtPrice = targetSqrt;
      tick = segmentEndTick;
      boundariesCrossed += 1;

      if (targetSqrt === priceLimit) {
        return {
          ok: false,
          refusal: 'PRICE_LIMIT',
          amountIn: amountIn - remaining,
          amountOut,
          endSqrtPriceX64: sqrtPrice,
          endTick: tick,
          steps,
          boundariesCrossed,
          feeAmount: feeTotal,
        };
      }
      if (boundary === null) return refuse('LIQUIDITY_UNREFERENCED');
      continue;
    }

    // Partial segment: solve for the sqrt price reached by `remaining`.
    const netAvailable =
      feePpm === 0n ? remaining : mulDivFloor(remaining, feeDenominator - feePpm, feeDenominator);
    if (netAvailable <= 0n) return refuse('AMOUNT_TOO_LARGE');

    const reached = aToB
      ? sqrtPriceAfterAmountA(sqrtPrice, netAvailable, liquidity)
      : sqrtPriceAfterAmountB(sqrtPrice, netAvailable, liquidity);
    if (reached === null) return refuse('AMOUNT_TOO_LARGE');

    const outForSegment = aToB
      ? amountBDelta(sqrtPrice, reached, liquidity, false)
      : amountADelta(sqrtPrice, reached, liquidity, false);
    steps.push({
      fromTick: tick,
      toTick: tickAtSqrtPriceX64Clamped(reached),
      liquidity,
      sqrtPriceFrom: sqrtPrice,
      sqrtPriceTo: reached,
      amountIn: remaining,
      amountOut: outForSegment,
      final: true,
    });
    amountOut += outForSegment;
    feeTotal += remaining - netAvailable;
    sqrtPrice = reached;
    remaining = 0n;
    tick = tickAtSqrtPriceX64Clamped(reached);
    break;
  }

  if (remaining > 0n) return refuse('AMOUNT_TOO_LARGE');

  return {
    ok: true,
    refusal: null,
    amountIn,
    amountOut,
    endSqrtPriceX64: sqrtPrice,
    endTick: tick,
    steps,
    boundariesCrossed,
    feeAmount: feeTotal,
  };
}

/** sqrt price at a tick, clamped to the program's legal range. */
function sqrtPriceX64AtTickClamped(tick: number): bigint {
  const clamped = Math.max(MIN_TICK_INDEX, Math.min(MAX_TICK_INDEX, tick));
  const value = sqrtPriceX64AtTick(clamped);
  return value < MIN_SQRT_PRICE ? MIN_SQRT_PRICE : value > MAX_SQRT_PRICE ? MAX_SQRT_PRICE : value;
}

function tickAtSqrtPriceX64Clamped(sqrtPriceX64: bigint): number {
  const clamped =
    sqrtPriceX64 < MIN_SQRT_PRICE
      ? MIN_SQRT_PRICE
      : sqrtPriceX64 > MAX_SQRT_PRICE
        ? MAX_SQRT_PRICE
        : sqrtPriceX64;
  return tickAtSqrtPriceX64(clamped);
}

/**
 * Sqrt price after selling `amount` of token A into liquidity L.
 *
 * From Δx = L/√P_new − L/√P_old the closed form is
 *   √P_new = (L·√P_old) / (L + Δx·√P_old)
 * with the Q64 scaling kept explicit. Returns null if the result leaves range.
 */
function sqrtPriceAfterAmountA(sqrtPrice: bigint, amount: bigint, liquidity: bigint): bigint | null {
  if (amount === 0n) return sqrtPrice;
  const numerator = liquidity * sqrtPrice;
  const denominator = liquidity + ((amount * sqrtPrice) >> 64n);
  if (denominator <= 0n) return null;
  const result = numerator / denominator;
  if (result < MIN_SQRT_PRICE || result > MAX_SQRT_PRICE || result <= 0n) return null;
  return result;
}

/** Sqrt price after selling `amount` of token B into liquidity L. */
function sqrtPriceAfterAmountB(sqrtPrice: bigint, amount: bigint, liquidity: bigint): bigint | null {
  if (amount === 0n) return sqrtPrice;
  if (liquidity <= 0n) return null;
  const result = sqrtPrice + ((amount << 64n) / liquidity);
  if (result < MIN_SQRT_PRICE || result > MAX_SQRT_PRICE) return null;
  return result;
}

/*
 * The TickArray layout lives in ./tickarray — it is imported from there directly
 * by the venue layer so that the byte geometry has exactly one definition.
 */

export {
  decodeTickArray,
  TickArrayDecodeError,
  TICK_ARRAY_SIZE,
  TICK_ARRAY_TICKS_SIZE,
  TICK_ARRAY_TICKS_OFFSET,
  TICK_BYTES,
} from './tickarray';
export type { DecodedTickArray } from './tickarray';
