
import test from 'node:test';
import assert from 'node:assert/strict';

import { percentileOf, summarisePriorityFee } from '../../packages/rpc/src/priority-fee';

const base = {
  percentile: 0.75,
  floorMicroLamports: 1_000,
  ceilingMicroLamports: 150_000,
  minSamples: 4,
} as const;

function summarise(samples: number[], overrides: Partial<Parameters<typeof summarisePriorityFee>[0]> = {}) {
  return summarisePriorityFee({ samples, ...base, ...overrides });
}

test('nearest-rank percentile is exact at the edges and interior', () => {
  const values = [10, 20, 30, 40];
  assert.equal(percentileOf(values, 0), 10);
  assert.equal(percentileOf(values, 1), 40);
  assert.equal(percentileOf(values, 0.5), 20);
  assert.equal(percentileOf(values, 0.75), 30);
  assert.equal(percentileOf([], 0.5), 0);
});

test('a long tail does not drag the bid up (the reason for a percentile)', () => {
  // One payer bidding 10_000_000 would move a MEAN to ~1.25M. The p75 must not
  // follow it, because that is not what normal inclusion costs.
  const samples = [1_000, 1_100, 1_200, 1_300, 10_000_000];
  const estimate = summarise(samples);
  assert.equal(estimate.microLamports, 1_300, 'bids at the population value, not the outlier');
  assert.equal(estimate.source, 'chain-samples');
});

test('zero-fee slots are excluded from the percentile but still counted', () => {
  const estimate = summarise([0, 0, 0, 5_000, 6_000, 7_000, 8_000]);
  assert.equal(estimate.nonZeroSamples, 4);
  assert.equal(estimate.sampleCount, 7);
  assert.ok(estimate.microLamports >= 5_000, 'never bids zero from a real sample set');
});

test('too few non-zero samples refuses instead of guessing', () => {
  const estimate = summarise([0, 0, 0, 2_000], { fallbackMicroLamports: null });
  assert.equal(estimate.source, 'unavailable');
  assert.equal(estimate.microLamports, 0, 'zero signals the caller to refuse the attempt');
});

test('a configured fallback is used AND clamped when samples are thin', () => {
  const low = summarise([0, 0], { fallbackMicroLamports: 10, minSamples: 8 });
  assert.equal(low.microLamports, base.floorMicroLamports, 'fallback cannot go below the floor');

  const high = summarise([0, 0], { fallbackMicroLamports: 9_000_000, minSamples: 8 });
  assert.equal(high.microLamports, base.ceilingMicroLamports, 'fallback cannot exceed the ceiling');
});

test('a fee spike is clamped at the ceiling and labelled as such', () => {
  const estimate = summarise([400_000, 500_000, 600_000, 700_000]);
  assert.equal(estimate.microLamports, base.ceilingMicroLamports);
  assert.equal(estimate.source, 'ceiling-clamped');
  assert.equal(estimate.rawPercentile, 600_000, 'the unclamped value is retained for traceability');
});

test('a very quiet chain is lifted to the floor, never to zero', () => {
  const estimate = summarise([1, 2, 3, 4]);
  assert.equal(estimate.microLamports, base.floorMicroLamports);
  assert.equal(estimate.source, 'floor-clamped');
});

test('non-finite and negative samples cannot poison the estimate', () => {
  const estimate = summarise([Number.NaN, -5, Infinity, 5_000, 6_000, 7_000, 8_000]);
  assert.equal(estimate.sampleCount, 4, 'NaN, negative and Infinity are discarded');
  assert.ok(estimate.microLamports >= 5_000);
});

test('an empty sample set with no fallback refuses', () => {
  const estimate = summarise([], { fallbackMicroLamports: null });
  assert.equal(estimate.source, 'unavailable');
  assert.equal(estimate.microLamports, 0);
});

test('percentile is bounded even when configured outside 0..1', () => {
  const low = summarise([1_000, 2_000, 3_000, 4_000], { percentile: -3 });
  assert.equal(low.rawPercentile, 1_000, 'clamps to the 0th percentile');
  const high = summarise([1_000, 2_000, 3_000, 4_000], { percentile: 9 });
  assert.equal(high.rawPercentile, 4_000, 'clamps to the 100th percentile');
});
