/**
 * Strategy invariants on a synthetic, deterministic two-pool market.
 *
 * A closed cycle with positive fees cannot be profitable in both directions at
 * once — if it could, the pools would be a free money machine, which is exactly
 * the bug class these tests are here to catch.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolSnapshot } from '../../chains/solana/src/whirlpool';
import { discoverPair, bestCandidate, legReserves } from '../../packages/strategies/src/arb';
import type { PoolBinding } from '../../packages/registry/src';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function binding(address: string, feeRatePpm: number): PoolBinding {
  return {
    address,
    dexFamily: 'orca-whirlpool',
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    poolVersion: 'whirlpool-v1',
    mintA: WSOL_MINT,
    mintB: USDC_MINT,
    decimalsA: 9,
    decimalsB: 6,
    tickSpacing: 8,
    feeRatePpm,
    qualifiedAt: '2026-10-27T00:00:00.000Z',
    observedProgramIdentity: 'whirlpool-program',
    sourceProofRefs: ['test'],
    maxAgeMs: 3_600_000,
  };
}

function snapshot(input: {
  address: string;
  reserveSolLamports: bigint;
  reserveUsdcRaw: bigint;
  feeRatePpm?: number;
  slot?: number;
}): PoolSnapshot {
  return {
    poolAddress: input.address,
    binding: binding(input.address, input.feeRatePpm ?? 400),
    sqrtPriceX64: 1n,
    liquidityRaw: 1_000_000n,
    feeRatePpm: input.feeRatePpm ?? 400,
    protocolFeeRatePpm: 0,
    tickSpacing: 8,
    tickIndex: 0,
    reserveA: input.reserveSolLamports,
    reserveB: input.reserveUsdcRaw,
    slot: input.slot ?? 100,
    observedAtUtc: new Date().toISOString(),
    observedMonoNs: 0n,
    sourceProviderId: 'primary',
    coherence: 'COHERENT',
    qualityFlags: [],
  };
}

test('legReserves maps settlement->base onto the correct vault side', () => {
  const pool = snapshot({ address: 'poolA', reserveSolLamports: 1_000n, reserveUsdcRaw: 5_000n });
  const buy = legReserves(pool, USDC_MINT, 'SETTLEMENT_TO_BASE');
  assert.ok(buy);
  // Settling in USDC (mint B) means selling B: input is reserveB.
  assert.equal(buy.aToB, false);
  assert.equal(buy.reserveIn, 5_000n);
  assert.equal(buy.reserveOut, 1_000n);

  const sell = legReserves(pool, USDC_MINT, 'BASE_TO_SETTLEMENT');
  assert.ok(sell);
  assert.equal(sell.aToB, true);
  assert.equal(sell.reserveIn, 1_000n);
});

test('a closed cycle cannot be profitable in both directions', () => {
  // Identical pools: fees alone make both directions loss-making.
  const poolA = snapshot({ address: 'poolA', reserveSolLamports: 1_000_000n, reserveUsdcRaw: 100_000_000n });
  const poolB = snapshot({ address: 'poolB', reserveSolLamports: 1_000_000n, reserveUsdcRaw: 100_000_000n });

  const candidates = discoverPair({
    settlementMint: USDC_MINT,
    poolA,
    poolB,
    amountInRaw: 1_000_000n,
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.grossSurplusRaw < 0n));
});

test('a genuinely imbalanced pair produces exactly one profitable direction', () => {
  // poolA prices SOL cheaper than poolB, so buy on A and sell on B wins.
  const poolA = snapshot({ address: 'poolA', reserveSolLamports: 1_000_000_000n, reserveUsdcRaw: 90_000_000_000n, feeRatePpm: 100 });
  const poolB = snapshot({ address: 'poolB', reserveSolLamports: 1_000_000_000n, reserveUsdcRaw: 110_000_000_000n, feeRatePpm: 100 });

  const candidates = discoverPair({
    settlementMint: USDC_MINT,
    poolA,
    poolB,
    amountInRaw: 10_000_000n,
  });

  const profitable = candidates.filter((c) => c.grossSurplusRaw > 0n);
  assert.equal(profitable.length, 1);

  const best = bestCandidate(candidates);
  assert.ok(best);
  assert.ok(best.grossSurplusRaw > 0n);
  assert.notEqual(best.buyPool, best.sellPool);
});

test('a pair without reserves yields no candidates', () => {
  const empty = { ...snapshot({ address: 'poolA', reserveSolLamports: 0n, reserveUsdcRaw: 0n }), reserveA: null };
  const other = snapshot({ address: 'poolB', reserveSolLamports: 1n, reserveUsdcRaw: 1n });
  const candidates = discoverPair({
    settlementMint: USDC_MINT,
    poolA: empty,
    poolB: other,
    amountInRaw: 1_000_000n,
  });
  assert.equal(candidates.length, 0);
});
