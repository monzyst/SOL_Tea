/**
 * packages/market — freshness semantics.
 *
 * These tests encode the two modelling mistakes this module originally made.
 * Both were invisible to unit tests written against the wrong model, and both
 * made the engine reject every healthy pair forever on mainnet:
 *
 *  1. Freshness measured as wall-clock age since the pool account last changed.
 *     A quiet pool never changes, so it looked permanently stale.
 *  2. Leg-vs-leg slot skew. Pool accounts change only on swaps, so two healthy
 *     legs routinely differ by hundreds of slots.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MarketStateStore } from '../../packages/market/src';
import type { PoolSnapshot } from '../../chains/solana/src/whirlpool';

const POOL_A = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const POOL_B = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';

function snapshot(overrides: Partial<PoolSnapshot> & { poolAddress: string }): PoolSnapshot {
  return {
    slot: 1,
    tickIndex: -23_000,
    sqrtPriceX64: 79_000_000_000_000_000_000n,
    liquidity: 1_000_000n,
    feeRatePpm: 400,
    tickSpacing: 4,
    vaultA: 'vault-a',
    vaultB: 'vault-b',
    reserveA: 0n,
    reserveB: 0n,
    coherence: 'COHERENT',
    qualityFlags: [],
    observedAtUtc: new Date().toISOString(),
    observedMonoNs: 0n,
    sourceProviderId: 'primary',
    ...overrides,
  } as PoolSnapshot;
}

test('a quiet pool that has not traded for minutes is still quotable', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const market = new MarketStateStore({
    maxQuoteAgeMs: 2_000,
    maxSkewSlots: 25,
    nowUtc: () => now,
    maxSlotLag: 400,
  });

  // Chain tip has advanced; pool B last changed 5 minutes (wall clock) ago but is
  // only 10 slots behind the tip. That is current state, not a stale feed.
  market.setChainTipSlot(462_048_300);
  market.apply(
    snapshot({
      poolAddress: POOL_A,
      slot: 462_048_295,
      observedAtUtc: new Date(now - 500).toISOString(),
    }),
  );
  market.apply(
    snapshot({
      poolAddress: POOL_B,
      slot: 462_048_290,
      observedAtUtc: new Date(now - 300_000).toISOString(),
    }),
  );

  const readiness = market.readiness(POOL_A, POOL_B);
  assert.equal(readiness.ready, true, `expected ready, got ${readiness.reason}`);
});

test('healthily skewed legs are not rejected for their slot difference alone', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const market = new MarketStateStore({
    maxQuoteAgeMs: 2_000,
    // Deliberately tighter than the observed skew, to prove the test is not
    // silently passing because of a generous budget.
    maxSkewSlots: 5,
    nowUtc: () => now,
    maxSlotLag: 400,
  });

  market.setChainTipSlot(462_048_300);
  market.apply(snapshot({ poolAddress: POOL_A, slot: 462_048_299 }));
  market.apply(snapshot({ poolAddress: POOL_B, slot: 462_048_100 }));

  const readiness = market.readiness(POOL_A, POOL_B);
  assert.equal(readiness.ready, true, 'a 199-slot leg skew is normal for CLMM state');
  assert.equal(readiness.detail['legSkewSlots'], 199, 'skew is still reported for observability');
});

test('a leg genuinely behind the chain tip is rejected as stale', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const market = new MarketStateStore({
    maxQuoteAgeMs: 2_000,
    maxSkewSlots: 25,
    nowUtc: () => now,
    maxSlotLag: 100,
  });

  market.setChainTipSlot(462_048_300);
  market.apply(snapshot({ poolAddress: POOL_A, slot: 462_048_299 }));
  // 500 slots behind a tip whose budget is 100: this feed is not current.
  market.apply(snapshot({ poolAddress: POOL_B, slot: 462_047_800 }));

  const readiness = market.readiness(POOL_A, POOL_B);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'FEED_STALE');
  assert.equal(readiness.detail['lagB'], 500);
});

test('before any heartbeat, wall-clock age is the conservative fallback', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const market = new MarketStateStore({ maxQuoteAgeMs: 2_000, maxSkewSlots: 25, nowUtc: () => now });

  market.apply(
    snapshot({ poolAddress: POOL_A, slot: 10, observedAtUtc: new Date(now - 60_000).toISOString() }),
  );
  market.apply(
    snapshot({ poolAddress: POOL_B, slot: 11, observedAtUtc: new Date(now - 60_000).toISOString() }),
  );

  const readiness = market.readiness(POOL_A, POOL_B);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'FEED_STALE');
});

test('an invalidated pool stays untrusted until fresh bytes arrive', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const market = new MarketStateStore({ maxQuoteAgeMs: 2_000, maxSkewSlots: 25, nowUtc: () => now });
  market.setChainTipSlot(100);
  market.apply(snapshot({ poolAddress: POOL_A, slot: 99 }));
  market.apply(snapshot({ poolAddress: POOL_B, slot: 99 }));

  market.invalidate(POOL_A, 'STREAM_GAP');
  assert.equal(market.readiness(POOL_A, POOL_B).reason, 'FEED_GAP');

  market.apply(snapshot({ poolAddress: POOL_A, slot: 100 }));
  assert.equal(market.readiness(POOL_A, POOL_B).ready, true, 'a fresh update restores trust');
});
