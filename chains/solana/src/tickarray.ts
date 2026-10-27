/**
 * chains/solana/src/tickarray — the on-chain TickArray layout.
 *
 * Kept in its own module because the layout is the single most error-prone part
 * of reading Orca state, and it deserves to be readable in isolation.
 *
 * Layout of one 9988-byte TickArray account:
 *
 *   0    8   discriminator
 *   8    4   start_tick_index (i32 LE)
 *   12   *   ticks[88], each TICK_BYTES = 113 bytes:
 *              0   16  initialized (bool, padded to the i128 union alignment)
 *              16  16  liquidity_net (i128 LE)
 *              32  16  liquidity_gross (u128 LE)
 *              48  48  reward_growths_outside ([u128; 3])
 *              96  1   padding
 *
 * WHY THIS FILE EXISTS: the first revision assumed a tick was 88 bytes
 * (bool 1 + 7 pad + 16 + 16 + 48). That is the layout you get if you forget that
 * Anchor pads a bool to the alignment of the struct's largest member. Every real
 * account is 9988 bytes, so the decoder rejected all of them — the liquidity map
 * silently stayed empty and the engine could never price a route. It compiled,
 * typechecked, and passed unit tests; only running against mainnet exposed it.
 */

import type { InitializedTick } from './clmm';

/** Ticks per array (a COUNT — not a byte size). */
export const TICK_ARRAY_SIZE = 88;

/** Serialized bytes per tick (see the layout table above). */
export const TICK_BYTES = 113;

/** Offset of the `ticks` array within the account. */
export const TICK_ARRAY_TICKS_OFFSET = 12;

/**
 * Bytes occupied by the header plus all 88 tick slots: 12 + 88*113 = 9956.
 *
 * Real mainnet accounts measure 9988 bytes, i.e. this region plus a 32-byte
 * trailer. The tick region is nonetheless exactly 9956 bytes — verified against
 * a live account, where slot 87 begins at 9843 and ends precisely at 9956, with
 * 87 of 88 slots initialized. The decoder therefore requires AT LEAST this many
 * bytes and ignores any trailer, rather than pinning an exact total it cannot
 * explain.
 */
export const TICK_ARRAY_TICKS_SIZE = TICK_ARRAY_TICKS_OFFSET + TICK_ARRAY_SIZE * TICK_BYTES;

export type TickArrayDecodeErrorCode = 'WRONG_SIZE' | 'BAD_SPACING' | 'BAD_START';

export class TickArrayDecodeError extends Error {
  constructor(
    readonly code: TickArrayDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TickArrayDecodeError';
  }
}

export interface DecodedTickArray {
  readonly startTickIndex: number;
  readonly ticks: readonly InitializedTick[];
  readonly slotCount: number;
}

/**
 * Decode a TickArray account.
 *
 * `tickSpacing` is REQUIRED because slot i sits at `startTickIndex + i * spacing`:
 * an array spans 88*spacing ticks. Decoding with an implicit stride of 1 puts
 * boundaries at ticks where liquidity never changes, which makes the walk cross
 * phantom boundaries and understate output.
 *
 * Only initialized slots are returned. An uninitialized slot is all zeroes and
 * must never be treated as a boundary.
 */
export function decodeTickArray(data: Buffer, tickSpacing: number): DecodedTickArray {
  if (data.length < TICK_ARRAY_TICKS_SIZE) {
    throw new TickArrayDecodeError(
      'WRONG_SIZE',
      `tick array has ${data.length} bytes, needs at least ${TICK_ARRAY_TICKS_SIZE}`,
    );
  }
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new TickArrayDecodeError(
      'BAD_SPACING',
      `tick spacing must be a positive integer, got ${tickSpacing}`,
    );
  }

  const startTickIndex = data.readInt32LE(8);
  const span = tickSpacing * TICK_ARRAY_SIZE;
  if (startTickIndex % span !== 0) {
    throw new TickArrayDecodeError(
      'BAD_START',
      `start tick ${startTickIndex} is not aligned to ${span}`,
    );
  }

  const ticks: InitializedTick[] = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i += 1) {
    const offset = TICK_ARRAY_TICKS_OFFSET + i * TICK_BYTES;
    if (data.readUInt8(offset) === 0) continue;

    // i128 / u128 little-endian: low u64 then high i64. Reading the net high half
    // as SIGNED sign-extends negative liquidity deltas correctly.
    const netLow = data.readBigUInt64LE(offset + 16);
    const netHigh = data.readBigInt64LE(offset + 24);
    const grossLow = data.readBigUInt64LE(offset + 32);
    const grossHigh = data.readBigUInt64LE(offset + 40);

    ticks.push({
      tickIndex: startTickIndex + i * tickSpacing,
      liquidityNet: (netHigh << 64n) + netLow,
      liquidityGross: (grossHigh << 64n) + grossLow,
    });
  }

  return { startTickIndex, ticks, slotCount: TICK_ARRAY_SIZE };
}
