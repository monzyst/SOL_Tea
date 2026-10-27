/**
 * chains/solana/tickarray — byte-layout regression tests.
 *
 * The layout bug this file guards against: a tick is 113 bytes, not 88. The
 * wrong stride made every mainnet account fail the size check, so the liquidity
 * map stayed empty and no route could ever be priced. These tests pin the
 * geometry to numbers measured from a real account.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TICK_ARRAY_SIZE,
  TICK_ARRAY_TICKS_OFFSET,
  TICK_ARRAY_TICKS_SIZE,
  TICK_BYTES,
  TickArrayDecodeError,
  decodeTickArray,
} from '../../chains/solana/src/tickarray';

/** Build an account image with the real geometry. */
function buildArray(input: {
  startTickIndex: number;
  tickSpacing?: number;
  trailerBytes?: number;
  ticks?: Array<{ slot: number; liquidityNet: bigint; liquidityGross: bigint }>;
}): Buffer {
  const total = TICK_ARRAY_TICKS_SIZE + (input.trailerBytes ?? 0);
  const buffer = Buffer.alloc(total);
  buffer.writeInt32LE(input.startTickIndex, 8);
  for (const tick of input.ticks ?? []) {
    const offset = TICK_ARRAY_TICKS_OFFSET + tick.slot * TICK_BYTES;
    buffer.writeUInt8(1, offset);
    buffer.writeBigUInt64LE(tick.liquidityNet & ((1n << 64n) - 1n), offset + 16);
    buffer.writeBigInt64LE(tick.liquidityNet >> 64n, offset + 24);
    buffer.writeBigUInt64LE(tick.liquidityGross & ((1n << 64n) - 1n), offset + 32);
    buffer.writeBigUInt64LE(tick.liquidityGross >> 64n, offset + 40);
  }
  return buffer;
}

test('the tick region is 9956 bytes; a real account is that plus a 32-byte trailer', () => {
  assert.equal(TICK_BYTES, 113, 'a tick is 113 bytes: bool(16) + 2x i128(32) + rewards(48) + pad(1)');
  assert.equal(TICK_ARRAY_SIZE, 88, '88 slots per array');
  assert.equal(TICK_ARRAY_TICKS_SIZE, 12 + 88 * 113);
  // Measured on mainnet: the account is 9988 bytes.
  assert.equal(TICK_ARRAY_TICKS_SIZE + 32, 9988);
});

test('an account carrying the 32-byte trailer decodes (the original failure)', () => {
  const data = buildArray({
    startTickIndex: -23936,
    tickSpacing: 4,
    trailerBytes: 32,
    ticks: [{ slot: 0, liquidityNet: 100n, liquidityGross: 100n }],
  });
  assert.equal(data.length, 9988);
  const decoded = decodeTickArray(data, 4);
  assert.equal(decoded.startTickIndex, -23936);
  assert.equal(decoded.ticks.length, 1);
});

test('an account one byte short is rejected rather than misread', () => {
  const data = buildArray({ startTickIndex: 0, tickSpacing: 1 });
  const short = data.subarray(0, TICK_ARRAY_TICKS_SIZE - 1);
  assert.throws(() => decodeTickArray(short, 1), TickArrayDecodeError);
});

test('slot index is scaled by the pool tick spacing', () => {
  const data = buildArray({
    startTickIndex: -23936,
    tickSpacing: 4,
    ticks: [
      { slot: 0, liquidityNet: 1n, liquidityGross: 1n },
      { slot: 7, liquidityNet: -1n, liquidityGross: 1n },
    ],
  });
  const decoded = decodeTickArray(data, 4);
  assert.deepEqual(
    decoded.ticks.map((t) => t.tickIndex),
    [-23936, -23936 + 28],
    'slot 7 with spacing 4 is 28 ticks away, not 7',
  );
});

test('an unaligned start tick is refused', () => {
  // 88 * 4 = 352; -23937 is not a multiple of 352.
  const data = buildArray({ startTickIndex: -23937, tickSpacing: 4 });
  assert.throws(() => decodeTickArray(data, 4), /not aligned/);
});

test('non-positive tick spacing is refused', () => {
  const data = buildArray({ startTickIndex: 0, tickSpacing: 1 });
  assert.throws(() => decodeTickArray(data, 0), /tick spacing/);
  assert.throws(() => decodeTickArray(data, -4), /tick spacing/);
});

test('negative liquidityNet survives the signed high half', () => {
  const negative = -((1n << 90n) + 7n);
  const huge = (1n << 120n) + 999n;
  const data = buildArray({
    startTickIndex: 0,
    tickSpacing: 1,
    ticks: [{ slot: 3, liquidityNet: negative, liquidityGross: huge }],
  });
  const decoded = decodeTickArray(data, 1);
  assert.equal(decoded.ticks[0]?.liquidityNet, negative);
  assert.equal(decoded.ticks[0]?.liquidityGross, huge);
});

test('uninitialized slots are omitted, not treated as boundaries', () => {
  const data = buildArray({
    startTickIndex: 0,
    tickSpacing: 1,
    ticks: [{ slot: 1, liquidityNet: 5n, liquidityGross: 5n }],
  });
  const decoded = decodeTickArray(data, 1);
  assert.equal(decoded.ticks.length, 1);
  assert.equal(decoded.slotCount, 88);
});
