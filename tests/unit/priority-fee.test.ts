/**
 * packages/rpc/priority-fee — policy tests.
 *
 * These tests exist because the failure modes are asymmetric and expensive:
 * under-bidding silently loses every attempt, and over-bidding silently loses
 * money on every attempt. Neither shows up as an error, so the policy has to be
 * pinned by tests rather than observed in production.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  percentileOf,
  summarisePriorityFee,
  PriorityFeeEstimator,
} from '../../packages/rpc/src/priority-fee';
import type { Logger } from '../../packages/obs/src';

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

const base = {
  percentile: 0.5,
  floorMicroLamports: 1_000,
  ceilingMicroLamports: 200_000,
  minSamples: 3,
};

test('percentileOf uses nearest-rank and clamps its input', () => {
  const sorted = [10, 20, 30, 40, 50];
  assert.equal(percentileOf(sorted, 0), 10);
  assert.equal(percentileOf(sorted, 0.5), 30, 'median of five is the third value');
  assert.equal(percentileOf(sorted, 1), 50);
  assert.equal(percentileOf(sorted, 2), 50, 'out-of-range percentile clamps');
  assert.equal(percentileOf(sorted, -1), 10);
  assert.equal(percentileOf([], 0.5), 0);
});

test('the mean would overpay on a long-tailed distribution; the median does not', () => {
  // One payer bidding 5,000,000 dominates the arithmetic mean.
  const samples = [1_000, 1_000, 1_200, 1_500, 5_000_000];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  const estimate = summarisePriorityFee({ ...base, samples });
  assert.equal(estimate.source, 'chain-samples');
  assert.equal(estimate.microLamports, 1_200, 'median wins, not the outlier');
  // Two orders of magnitude below the mean: bidding the mean here would pay
  // ~4,000x the inclusion price.
  assert.ok(estimate.microLamports * 100 < mean, `estimate ${estimate.microLamports} is not far below mean ${mean}`);
});

test('zero-fee samples do not dilute the estimate', () => {
  // Quiet chain: most recent slots paid nothing at all. Those are not evidence
  // that we should bid zero — they are evidence the chain is quiet, and the floor
  // applies.
  const estimate = summarisePriorityFee({ ...base, samples: [0, 0, 0, 0, 0, 0, 0, 0, 900] });
  assert.equal(estimate.nonZeroSamples, 1);
  assert.equal(estimate.source, 'unavailable', 'fewer than minSamples non-zero values');
  assert.equal(estimate.microLamports, 0);
});

test('too few samples refuses rather than guessing', () => {
  const estimate = summarisePriorityFee({ ...base, samples: [5_000, 6_000] });
  assert.equal(estimate.source, 'unavailable');
  assert.equal(estimate.microLamports, 0, 'an unavailable estimate must never look biddable');
});

test('a configured fallback applies only when sampling is unusable', () => {
  const estimate = summarisePriorityFee({
    ...base,
    samples: [],
    fallbackMicroLamports: 12_000,
  });
  assert.equal(estimate.source, 'floor-clamped');
  assert.equal(estimate.microLamports, 12_000);
});

test('the floor lifts a below-floor bid', () => {
  const estimate = summarisePriorityFee({ ...base, samples: [10, 20, 30] });
  assert.equal(estimate.source, 'floor-clamped');
  assert.equal(estimate.microLamports, 1_000);
});

test('the ceiling caps a pathological spike', () => {
  const estimate = summarisePriorityFee({
    ...base,
    samples: [900_000, 1_000_000, 2_000_000],
    percentile: 1,
  });
  assert.equal(estimate.source, 'ceiling-clamped');
  assert.equal(estimate.microLamports, 200_000, 'a fee spike cannot exceed the configured cap');
  assert.equal(estimate.rawPercentile, 2_000_000, 'the raw value is still reported for traceability');
});

test('negative and non-finite samples are discarded', () => {
  const estimate = summarisePriorityFee({
    ...base,
    samples: [-5, Number.NaN, Number.POSITIVE_INFINITY, 5_000, 6_000, 7_000],
  });
  assert.equal(estimate.sampleCount, 3, 'only the finite, non-negative values count');
  assert.equal(estimate.source, 'chain-samples');
});

test('estimator caches within its TTL', async () => {
  let calls = 0;
  const fakeConnection = {
    getRecentPrioritizationFees: async () => {
      calls += 1;
      return [{ prioritizationFee: 5_000 }, { prioritizationFee: 6_000 }, { prioritizationFee: 7_000 }];
    },
  };
  const estimator = new PriorityFeeEstimator({
    // The estimator only calls getRecentPrioritizationFees; the rest of the
    // Connection surface is irrelevant here.
    connection: fakeConnection as never,
    logger: silent,
    watchedAccounts: ['11111111111111111111111111111112'],
    ttlMs: 10_000,
    // The production default is 8 non-zero samples. This test supplies three, so
    // it must lower the bar explicitly rather than rely on an implicit default.
    minSamples: 3,
  });

  const first = await estimator.estimate();
  assert.equal(first.source, 'chain-samples');
  assert.equal(first.microLamports, 6_000, 'median of the three samples');

  await estimator.estimate();
  assert.equal(calls, 1, 'a cached estimate must not re-hit the RPC');
  assert.deepEqual(estimator.peek(), first);
});

test('concurrent callers share a single sampling request', async () => {
  let calls = 0;
  const fakeConnection = {
    getRecentPrioritizationFees: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ prioritizationFee: 9_000 }, { prioritizationFee: 9_500 }, { prioritizationFee: 10_000 }];
    },
  };
  const estimator = new PriorityFeeEstimator({
    connection: fakeConnection as never,
    logger: silent,
    watchedAccounts: ['11111111111111111111111111111112'],
  });

  const [a, b, c] = await Promise.all([estimator.estimate(), estimator.estimate(), estimator.estimate()]);
  assert.equal(calls, 1, 'three concurrent callers, one RPC call');
  assert.equal(a.microLamports, b.microLamports);
  assert.equal(b.microLamports, c.microLamports);
});

test('a sampling failure falls back to the last known good estimate', async () => {
  let fail = false;
  const fakeConnection = {
    getRecentPrioritizationFees: async () => {
      if (fail) throw new Error('rpc down');
      return [{ prioritizationFee: 50_000 }, { prioritizationFee: 60_000 }, { prioritizationFee: 70_000 }];
    },
  };
  const estimator = new PriorityFeeEstimator({
    connection: fakeConnection as never,
    logger: silent,
    watchedAccounts: ['11111111111111111111111111111112'],
    ttlMs: 0,
  });

  const good = await estimator.estimate();
  fail = true;
  const afterFailure = await estimator.estimate();
  assert.equal(afterFailure.microLamports, good.microLamports, 'stale-but-real beats invented');
});
