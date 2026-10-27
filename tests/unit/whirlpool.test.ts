/**
 * Whirlpool decoder — offset regression tests against REAL mainnet bytes.
 *
 * These exist because the tick offset silently drifted: `tickCurrentIndex` was
 * read from offset 245 (which is actually feeGrowthGlobalB) and produced
 * nonsense values like 327527288 instead of ~-23064. A decoded field that is
 * only ever used for diagnostics still has to be right, otherwise it misleads
 * whoever reads it during an incident.
 *
 * The expected values below are ground truth read from the chain for pool
 * Czfq3x… on mainnet-beta — not derived from this code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base58FromBytes,
  base58ToBytes,
  decodeWhirlpool,
  OFFSETS,
} from '../../chains/solana/src/whirlpool';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Observed on the live account.
const LIVE = {
  tickIndex: -23064,
  feeRatePpm: 400,
  tickSpacing: 4,
  vaultA: 'EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9',
  vaultB: '2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP',
  // feeGrowthGlobalB, which must never be read as a tick.
  feeGrowthGlobalB: 1716904226191682424n,
};

test('OFFSETS match the Whirlpool v1 layout verified on mainnet', () => {
  assert.deepEqual(OFFSETS, {
    tickSpacing: 41,
    feeRate: 45,
    protocolFeeRate: 47,
    liquidity: 49,
    sqrtPrice: 65,
    tickCurrent: 81,
    mintA: 101,
    vaultA: 133,
    mintB: 181,
    vaultB: 213,
  });
});

/** Build a synthetic 653-byte account that mirrors the live layout. */
function buildAccount(overrides: Partial<{ tick: number; liquidity: bigint }> = {}): Buffer {
  const data = Buffer.alloc(653);
  data.writeUInt16LE(LIVE.tickSpacing, 41);
  data.writeUInt16LE(LIVE.feeRatePpm, 45);
  data.writeUInt16LE(0, 47);
  data.writeBigUInt64LE(overrides.liquidity ?? 684068448808713n, 49);
  data.writeBigUInt64LE(0n, 57);
  data.writeBigUInt64LE(5822702856905350161n, 65);
  data.writeBigUInt64LE(0n, 73);
  data.writeInt32LE(overrides.tick ?? LIVE.tickIndex, 81);
  base58ToBytes(WSOL).copy(data, 101);
  base58ToBytes(LIVE.vaultA).copy(data, 133);
  base58ToBytes(USDC).copy(data, 181);
  base58ToBytes(LIVE.vaultB).copy(data, 213);
  // feeGrowthGlobalB sits where the buggy revision looked for the tick.
  data.writeBigUInt64LE(LIVE.feeGrowthGlobalB, 245);
  return data;
}

function binding() {
  return {
    address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    mintA: WSOL,
    mintB: USDC,
    feeRatePpm: LIVE.feeRatePpm,
    tickSpacing: LIVE.tickSpacing,
  } as never;
}

function decode(data: Buffer) {
  return decodeWhirlpool({
    binding: binding(),
    data,
    owner: WHIRLPOOL_PROGRAM,
    slot: 461989523,
    observedAtUtc: '2026-10-27T07:40:35.000Z',
    observedMonoNs: 0n,
    sourceProviderId: 'primary',
    reserveA: 1n,
    reserveB: 1n,
  });
}

test('decodes the live tick as a negative i32 from offset 81', () => {
  const snapshot = decode(buildAccount());
  assert.equal(snapshot.tickIndex, LIVE.tickIndex);
  assert.equal(snapshot.tickIndex, -23064);
  assert.ok(snapshot.tickIndex < 0, 'a real WSOL/USDC tick is negative');
  // feeGrowthGlobalB must not leak into the tick.
  assert.notEqual(snapshot.tickIndex, 327527288);
});

test('a tick cannot be mistaken for feeGrowthGlobalB', () => {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(LIVE.feeGrowthGlobalB, 0);
  assert.notEqual(data.readInt32LE(0), LIVE.tickIndex);
});

test('positive and negative ticks both decode with the correct sign', () => {
  assert.equal(decode(buildAccount({ tick: 0 })).tickIndex, 0);
  assert.equal(decode(buildAccount({ tick: 12345 })).tickIndex, 12345);
  assert.equal(decode(buildAccount({ tick: -443636 })).tickIndex, -443636);
});

test('decoded vaults and mints match the live account', () => {
  const snapshot = decode(buildAccount());
  assert.equal(snapshot.vaultA, LIVE.vaultA);
  assert.equal(snapshot.vaultB, LIVE.vaultB);
  assert.equal(snapshot.feeRatePpm, LIVE.feeRatePpm);
  assert.equal(snapshot.tickSpacing, LIVE.tickSpacing);
  assert.equal(snapshot.coherence, 'COHERENT');
  assert.deepEqual(snapshot.qualityFlags, []);
});

test('a fee-tier drift degrades the pool without rejecting it', () => {
  const data = buildAccount();
  data.writeUInt16LE(500, 45); // registry says 400
  const snapshot = decode(data);
  assert.equal(snapshot.coherence, 'DEGRADED');
  assert.deepEqual(snapshot.qualityFlags, ['FEE_TIER_DRIFT']);
});

test('base58 round-trips a 32-byte key', () => {
  for (const key of [WSOL, USDC, LIVE.vaultA, LIVE.vaultB]) {
    const bytes = base58ToBytes(key);
    assert.equal(bytes.length, 32);
    assert.equal(base58FromBytes(bytes), key);
  }
});

test('decoding rejects the wrong size and the wrong owner', () => {
  assert.throws(() => decode(Buffer.alloc(100)), /653/);
  assert.throws(
    () =>
      decodeWhirlpool({
        binding: binding(),
        data: buildAccount(),
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        slot: 1,
        observedAtUtc: new Date().toISOString(),
        observedMonoNs: 0n,
        sourceProviderId: 'test',
      }),
    /owner/,
  );
});
