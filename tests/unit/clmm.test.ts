/**
 * chains/solana/src/clmm — correctness tests against the SDK oracle.
 *
 * The point of these tests is NOT "the code returns something". It is that the
 * walk agrees with an independent implementation of the same math (the pinned
 * Orca SDK) on ordinary inputs, and that it behaves safely at the edges. A
 * hand-written concentrated-liquidity walk that is merely self-consistent can be
 * uniformly wrong — that is exactly how the reviewed implementation shipped a
 * truncated constant table (Z2-04).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import BN from 'bn.js';
import { PriceMath } from '@orca-so/whirlpools-sdk';
import {
  Q64,
  MIN_TICK_INDEX,
  MAX_TICK_INDEX,
  TICK_ARRAY_SIZE,
  TICK_ARRAY_TICKS_SIZE,
  TICK_BYTES,
  TICK_ARRAY_TICKS_OFFSET,
  amountADelta,
  amountBDelta,
  decodeTickArray,
  LiquidityMap,
  sqrtPriceX64AtTick,
  tickAtSqrtPriceX64,
  walkExactIn,
  type InitializedTick,
} from '../../chains/solana/src/clmm';

const sdkSqrt = (tick: number): bigint => BigInt(PriceMath.tickIndexToSqrtPriceX64(tick).toString());

test('tick -> sqrtPrice matches the SDK oracle across the full range', () => {
  const ticks = [MIN_TICK_INDEX, -443_000, -100_000, -23_064, -1, 0, 1, 10, 1_000, 88_000, 443_635, MAX_TICK_INDEX];
  for (const tick of ticks) {
    assert.equal(sqrtPriceX64AtTick(tick), sdkSqrt(tick), `tick ${tick} disagrees with SDK`);
  }
});

test('sqrtPrice -> tick matches the SDK oracle (round-trip)', () => {
  for (const tick of [-250_000, -23_064, -50, 0, 5, 12_345, 300_000]) {
    const sqrt = sdkSqrt(tick);
    assert.equal(tickAtSqrtPriceX64(sqrt), PriceMath.sqrtPriceX64ToTickIndex(new BN(sqrt.toString())));
  }
});

test('tick conversion rejects out-of-range ticks instead of clamping silently', () => {
  assert.throws(() => sqrtPriceX64AtTick(MAX_TICK_INDEX + 1), RangeError);
  assert.throws(() => sqrtPriceX64AtTick(MIN_TICK_INDEX - 1), RangeError);
  assert.throws(() => sqrtPriceX64AtTick(1.5), RangeError);
});

/**
 * Single-range, deep liquidity: the walk must equal the closed form exactly.
 *
 * With liquidity L constant between the current price and the target, the output
 * for an exact input is fully determined, so any discrepancy is an arithmetic bug
 * rather than a modelling choice.
 */
test('single-range walk matches the analytic closed form', () => {
  const tick = 0;
  const sqrtPrice = sdkSqrt(tick);
  const liquidity = 10n ** 15n;
  const feeRatePpm = 3_000; // 0.30%
  const amountIn = 10n ** 9n;

  // One boundary far above and far below so neither is reached.
  const map = new LiquidityMap({
    ticks: [
      { tickIndex: -10_000, liquidityNet: -liquidity, liquidityGross: liquidity },
      { tickIndex: 10_000, liquidityNet: liquidity, liquidityGross: liquidity },
    ],
    liquidityAtReference: liquidity,
    referenceTick: tick,
  });

  // Sell A: the price falls, so the reached price is L*sqrtP/(L + netIn*sqrtP/2^64)
  // — NOT sqrtP + netIn*2^64/L, which is the small-trade approximation and
  // diverges by O(x^2). The exact rational form is what the pool uses.
  const result = walkExactIn({
    amountIn,
    sqrtPriceX64: sqrtPrice,
    tickIndex: tick,
    liquidityMap: map,
    feeRatePpm,
    aToB: true,
  });

  assert.equal(result.ok, true, `walk refused: ${result.refusal}`);
  assert.equal(result.boundariesCrossed, 0, 'a partial step must not cross a boundary');

  const netIn = (amountIn * BigInt(1_000_000 - feeRatePpm)) / 1_000_000n;
  const expectedSqrt = (liquidity * sqrtPrice) / (liquidity + ((netIn * sqrtPrice) >> 64n));
  assert.equal(result.endSqrtPriceX64, expectedSqrt, 'reached sqrt price');

  // Output B = L*(sqrtP - sqrtNext)/2^64, floored.
  const expectedOut = (liquidity * (sqrtPrice - expectedSqrt)) / Q64;
  assert.equal(result.amountOut, expectedOut, 'output B');

  // Conservation: input split exactly into fee + net.
  assert.equal(result.amountIn - result.feeAmount, netIn, 'fee accounting');
  assert.ok(result.amountOut < amountIn, 'a fee-bearing round trip cannot produce free money');
});

test('amount deltas round in the direction the caller asks for', () => {
  const lo = 10n ** 18n;
  const hi = 11n ** 18n;
  const liquidity = 10n ** 15n;

  const upA = amountADelta(lo, hi, liquidity, true);
  const downA = amountADelta(lo, hi, liquidity, false);
  assert.ok(upA >= downA, 'input side rounds up');
  assert.ok(upA - downA <= 1n, 'rounding differs by at most one unit');

  const upB = amountBDelta(lo, hi, liquidity, true);
  const downB = amountBDelta(lo, hi, liquidity, false);
  assert.ok(upB >= downB);
  assert.ok(upB - downB <= 1n);
});

/**
 * THE regression this module exists for.
 *
 * Liquidity halves exactly at tick 10. A quote that starts at tick 0 and walks
 * past tick 10 must use the reduced liquidity for the portion beyond the
 * boundary. A constant-liquidity implementation would overstate the output, and
 * that overstatement is what makes a "profitable" quote revert on chain.
 */
test('liquidity change at a boundary is applied, not assumed away', () => {
  // Realistic magnitudes: a 0.05% pool with ~$1M locked holds liquidity on the
  // order of 1e12-1e15, so a 0.4-token trade is a small step relative to the
  // range. Using tiny liquidity here would make the trade jump the whole range
  // and never reach the boundary being tested.
  const bigLiquidity = 10n * 10n ** 13n;
  const smallLiquidity = 5n * 10n ** 11n;
  const sqrtPrice = sdkSqrt(0);
  const feeRatePpm = 0;

  const ticks: InitializedTick[] = [
    // Crossing upward past tick 10 REMOVES most of the liquidity.
    {
      tickIndex: 10,
      liquidityNet: -(bigLiquidity - smallLiquidity),
      liquidityGross: bigLiquidity - smallLiquidity,
    },
    { tickIndex: 1_000, liquidityNet: -(smallLiquidity), liquidityGross: smallLiquidity },
    // Upper terminal boundary so the map PROVES liquidity up to here; without it
    // the walk would (correctly) refuse for lack of reference beyond tick 1000.
    { tickIndex: 200_000, liquidityNet: -(0n), liquidityGross: 0n },
  ];
  const map = new LiquidityMap({
    ticks,
    liquidityAtReference: bigLiquidity,
    referenceTick: 0,
  });

  // Liquidity really does drop after the boundary.
  assert.equal(map.liquidityAt(0), bigLiquidity);
  assert.equal(map.liquidityAt(11), smallLiquidity);

  // Same size, with and without the boundary in the way.
  const withoutBoundary = new LiquidityMap({
    ticks: [
      { tickIndex: 1_000, liquidityNet: -bigLiquidity + smallLiquidity, liquidityGross: bigLiquidity },
      { tickIndex: 200_000, liquidityNet: -(0n), liquidityGross: 0n },
    ],
    liquidityAtReference: bigLiquidity,
    referenceTick: 0,
  });

  // Crossing tick 10 costs ~5.00e10 at bigLiquidity; continuing to tick 1000
  // would cost a further ~2.54e10 at smallLiquidity. 6e10 therefore crosses
  // exactly one boundary and terminates inside the second range.
  const amountIn = 6n * 10n ** 10n;
  const crossed = walkExactIn({
    amountIn,
    sqrtPriceX64: sqrtPrice,
    tickIndex: 0,
    liquidityMap: map,
    feeRatePpm,
    aToB: false,
  });
  const naive = walkExactIn({
    amountIn,
    sqrtPriceX64: sqrtPrice,
    tickIndex: 0,
    liquidityMap: withoutBoundary,
    feeRatePpm,
    aToB: false,
  });

  assert.equal(crossed.ok, true, `crossed walk refused: ${crossed.refusal}`);
  assert.equal(naive.ok, true, `naive walk refused: ${naive.refusal}`);
  assert.ok(crossed.boundariesCrossed >= 1, 'the walk must report the boundary it crossed');
  // Less liquidity ahead => strictly less output for the same input.
  assert.ok(
    crossed.amountOut < naive.amountOut,
    `crossing thinning liquidity must reduce output (crossed=${crossed.amountOut}, naive=${naive.amountOut})`,
  );
});

test('a walk that would leave the proven region refuses instead of extrapolating', () => {
  const liquidity = 10n ** 15n;
  const map = new LiquidityMap({
    // Only ONE boundary, above the current tick; nothing below.
    ticks: [{ tickIndex: 100, liquidityNet: liquidity, liquidityGross: liquidity }],
    liquidityAtReference: liquidity,
    referenceTick: 0,
  });

  // Selling A pushes price DOWN, away from the only loaded boundary, so the map
  // cannot prove liquidity out to the range limit.
  const result = walkExactIn({
    amountIn: 10n ** 12n,
    sqrtPriceX64: sdkSqrt(0),
    tickIndex: 0,
    liquidityMap: map,
    feeRatePpm: 3_000,
    aToB: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.refusal, 'LIQUIDITY_UNREFERENCED');
  assert.equal(result.amountOut, 0n, 'a refusal must not carry an optimistic output');
});

test('a price limit stops the walk and reports it', () => {
  const liquidity = 10n ** 15n;
  const map = new LiquidityMap({
    ticks: [
      { tickIndex: -100_000, liquidityNet: -liquidity, liquidityGross: liquidity },
      { tickIndex: 100_000, liquidityNet: liquidity, liquidityGross: liquidity },
    ],
    liquidityAtReference: liquidity,
    referenceTick: 0,
  });

  const limit = sdkSqrt(-50);
  const result = walkExactIn({
    amountIn: 10n ** 15n,
    sqrtPriceX64: sdkSqrt(0),
    tickIndex: 0,
    liquidityMap: map,
    feeRatePpm: 0,
    aToB: true,
    sqrtPriceLimit: limit,
  });

  assert.equal(result.ok, false);
  assert.equal(result.refusal, 'PRICE_LIMIT');
  assert.equal(result.endSqrtPriceX64, limit);
});

test('zero liquidity in the current range refuses rather than dividing by zero', () => {
  const map = new LiquidityMap({ ticks: [], liquidityAtReference: 0n, referenceTick: 0 });
  const result = walkExactIn({
    amountIn: 1_000n,
    sqrtPriceX64: sdkSqrt(0),
    tickIndex: 0,
    liquidityMap: map,
    feeRatePpm: 3_000,
    aToB: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal, 'ZERO_LIQUIDITY');
});

test('duplicate initialized ticks are rejected (a map must be unambiguous)', () => {
  assert.throws(
    () =>
      new LiquidityMap({
        ticks: [
          { tickIndex: 5, liquidityNet: 1n, liquidityGross: 1n },
          { tickIndex: 5, liquidityNet: 2n, liquidityGross: 2n },
        ],
        liquidityAtReference: 10n,
        referenceTick: 0,
      }),
    /duplicate/,
  );
});

/**
 * The naive `tick - (tick % spacing) - spacing` boundary search skips a real
 * boundary at tick 10 when starting from 15. This asserts we find the NEAREST
 * initialized tick instead of the nearest grid line.
 */
test('firstBoundaryBeyond finds the nearest initialized tick, not a grid line', () => {
  const map = new LiquidityMap({
    ticks: [
      { tickIndex: 10, liquidityNet: 1n, liquidityGross: 1n },
      { tickIndex: 40, liquidityNet: 1n, liquidityGross: 1n },
    ],
    liquidityAtReference: 10n,
    referenceTick: 15,
  });

  assert.equal(map.firstBoundaryBeyond(15, true), 10, 'downward search must find tick 10');
  assert.equal(map.firstBoundaryBeyond(15, false), 40, 'upward search must find tick 40');
  assert.equal(map.firstBoundaryBeyond(5, true), null, 'nothing below tick 5');
});

/* ------------------------------------------------------- tick array decoding */

function buildTickArray(input: {
  startTickIndex: number;
  initialized: Array<{ index: number; liquidityNet: bigint; liquidityGross: bigint }>;
}): Buffer {
  // Real geometry: 113-byte ticks (see chains/solana/src/tickarray.ts). Building
  // fixtures with an 88-byte tick would let the decoder pass tests while
  // rejecting every actual mainnet account.
  const buffer = Buffer.alloc(TICK_ARRAY_TICKS_SIZE);
  buffer.writeInt32LE(input.startTickIndex, 8);
  for (const entry of input.initialized) {
    const offset = TICK_ARRAY_TICKS_OFFSET + entry.index * TICK_BYTES;
    buffer.writeUInt8(1, offset);
    // Split each i128/u128 into low/high 64-bit halves, as the on-chain layout does.
    buffer.writeBigUInt64LE(entry.liquidityNet & ((1n << 64n) - 1n), offset + 16);
    buffer.writeBigInt64LE(entry.liquidityNet >> 64n, offset + 24);
    buffer.writeBigUInt64LE(entry.liquidityGross & ((1n << 64n) - 1n), offset + 32);
    buffer.writeBigUInt64LE(entry.liquidityGross >> 64n, offset + 40);
  }
  return buffer;
}

test('decodeTickArray reads initialized ticks and skips empty slots', () => {
  const data = buildTickArray({
    startTickIndex: -440,
    initialized: [
      { index: 0, liquidityNet: 5_000n, liquidityGross: 5_000n },
      { index: 7, liquidityNet: -2_500n, liquidityGross: 2_500n },
    ],
  });

  const decoded = decodeTickArray(data, 1);
  assert.equal(decoded.startTickIndex, -440);
  assert.equal(decoded.ticks.length, 2, 'uninitialized slots must not appear');
  assert.equal(decoded.ticks[0]?.tickIndex, -440);
  assert.equal(decoded.ticks[0]?.liquidityNet, 5_000n);
  assert.equal(decoded.ticks[1]?.tickIndex, -433);
  assert.equal(decoded.ticks[1]?.liquidityNet, -2_500n);
});

test('decodeTickArray preserves negative and 128-bit liquidity values', () => {
  const big = (1n << 100n) + 12_345n;
  const data = buildTickArray({
    startTickIndex: 0,
    initialized: [{ index: 1, liquidityNet: -big, liquidityGross: big }],
  });
  const decoded = decodeTickArray(data, 1);
  assert.equal(decoded.ticks[0]?.liquidityNet, -big);
  assert.equal(decoded.ticks[0]?.liquidityGross, big);
});

test('decodeTickArray rejects a wrong-sized account', () => {
  assert.throws(() => decodeTickArray(Buffer.alloc(100), 1), /needs at least/);
});
