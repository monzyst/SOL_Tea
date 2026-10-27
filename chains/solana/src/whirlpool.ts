/**
 * chains/solana/src/whirlpool — the Solana venue adapter.
 *
 * Two jobs, deliberately separated:
 *  - `decodeWhirlpool` turns live account bytes into a *coherent* pool snapshot
 *    (reserves + price + fees + slot). Pure function, no I/O, unit-testable.
 *  - `quoteExactIn` applies the constant-product approximation over the current
 *    reserves with the pool's fee tier. It is intentionally conservative and
 *    clearly labelled: the authoritative CLMM quote comes from the official
 *    Orca SDK at execution time (see `quoter.ts`), which walks real tick arrays.
 *    Using the SDK for execution and this function for discovery keeps the hot
 *    path fast while never pretending an approximation is an executable quote.
 */

import { WHIRLPOOL_PROGRAM_ID, type PoolBinding } from '../../../packages/registry/src';

/** whirlpool account discriminators / layout constants (Whirlpool v1, 653 bytes). */
export const WHIRLPOOL_ACCOUNT_SIZE = 653;
/** Byte offsets in the serialized `Whirlpool` account. */
export const OFFSETS = {
  tickSpacing: 41,
  feeRate: 45,
  protocolFeeRate: 47,
  liquidity: 49,
  sqrtPrice: 65,
  mintA: 101,
  vaultA: 133,
  mintB: 181,
  vaultB: 213,
  tickCurrent: 245,
} as const;

export interface PoolSnapshot {
  readonly poolAddress: string;
  readonly binding: PoolBinding;
  readonly sqrtPriceX64: bigint;
  readonly liquidityRaw: bigint;
  readonly feeRatePpm: number;
  readonly protocolFeeRatePpm: number;
  readonly tickSpacing: number;
  readonly tickIndex: number;
  /** Vault addresses, needed to read reserves in a single batched call. */
  readonly vaultA: string;
  readonly vaultB: string;
  /** Token amount currently held in each vault (requires a vault read). */
  readonly reserveA: bigint | null;
  readonly reserveB: bigint | null;
  readonly slot: number;
  readonly observedAtUtc: string;
  readonly observedMonoNs: bigint;
  readonly sourceProviderId: string;
  readonly coherence: 'COHERENT' | 'DEGRADED';
  readonly qualityFlags: readonly string[];
}

export class PoolDecodeError extends Error {
  constructor(
    readonly code: 'WRONG_SIZE' | 'WRONG_OWNER' | 'MINT_MISMATCH' | 'INVALID_PRICE',
    message: string,
  ) {
    super(message);
    this.name = 'PoolDecodeError';
  }
}

function readU128(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/**
 * Decode a live Whirlpool account. Throws rather than returning a half-valid
 * snapshot: a partially decoded pool must never reach the strategy layer.
 */
export function decodeWhirlpool(input: {
  binding: PoolBinding;
  data: Buffer;
  owner: string;
  slot: number;
  observedAtUtc: string;
  observedMonoNs: bigint;
  sourceProviderId: string;
  reserveA?: bigint | null;
  reserveB?: bigint | null;
}): PoolSnapshot {
  const { binding, data } = input;

  if (data.length !== WHIRLPOOL_ACCOUNT_SIZE) {
    throw new PoolDecodeError(
      'WRONG_SIZE',
      `pool ${binding.address} has ${data.length} bytes, expected ${WHIRLPOOL_ACCOUNT_SIZE}`,
    );
  }
  if (input.owner !== WHIRLPOOL_PROGRAM_ID) {
    throw new PoolDecodeError(
      'WRONG_OWNER',
      `pool ${binding.address} owner ${input.owner} is not the Whirlpool program`,
    );
  }

  // Mints are checked against the registry binding: if the venue ever changes
  // the mints behind this address we must invalidate the route, not trade it.
  const mintA = data.subarray(OFFSETS.mintA, OFFSETS.mintA + 32);
  const mintB = data.subarray(OFFSETS.mintB, OFFSETS.mintB + 32);
  const expectedA = base58ToBytes(binding.mintA);
  const expectedB = base58ToBytes(binding.mintB);
  if (!mintA.equals(expectedA) || !mintB.equals(expectedB)) {
    throw new PoolDecodeError(
      'MINT_MISMATCH',
      `pool ${binding.address} mints changed; registry binding is stale`,
    );
  }

  const vaultA = base58FromBytes(data.subarray(OFFSETS.vaultA, OFFSETS.vaultA + 32));
  const vaultB = base58FromBytes(data.subarray(OFFSETS.vaultB, OFFSETS.vaultB + 32));

  const sqrtPriceX64 = readU128(data, OFFSETS.sqrtPrice);
  if (sqrtPriceX64 === 0n) {
    throw new PoolDecodeError('INVALID_PRICE', `pool ${binding.address} reports sqrtPrice 0`);
  }

  const liquidityRaw = readU128(data, OFFSETS.liquidity);
  const feeRatePpm = data.readUInt16LE(OFFSETS.feeRate);
  const protocolFeeRatePpm = data.readUInt16LE(OFFSETS.protocolFeeRate);
  const tickSpacing = data.readUInt16LE(OFFSETS.tickSpacing);
  const tickIndex = data.readInt32LE(OFFSETS.tickCurrent);

  const qualityFlags: string[] = [];
  if (feeRatePpm !== binding.feeRatePpm) qualityFlags.push('FEE_TIER_DRIFT');
  if (tickSpacing !== binding.tickSpacing) qualityFlags.push('TICK_SPACING_DRIFT');
  if (liquidityRaw === 0n) qualityFlags.push('ZERO_LIQUIDITY');

  return {
    poolAddress: binding.address,
    binding,
    sqrtPriceX64,
    liquidityRaw,
    feeRatePpm,
    protocolFeeRatePpm,
    tickSpacing,
    tickIndex,
    vaultA,
    vaultB,
    reserveA: input.reserveA ?? null,
    reserveB: input.reserveB ?? null,
    slot: input.slot,
    observedAtUtc: input.observedAtUtc,
    observedMonoNs: input.observedMonoNs,
    sourceProviderId: input.sourceProviderId,
    coherence: qualityFlags.length === 0 ? 'COHERENT' : 'DEGRADED',
    qualityFlags,
  };
}

/** sqrtPriceX64^2 / 2^128 scaled by decimals gives tokenB per tokenA as a float. */
export function sqrtPriceToPrice(sqrtPriceX64: bigint, decimalsA: number, decimalsB: number): number {
  const ratio = Number(sqrtPriceX64) / 2 ** 64;
  return ratio * ratio * 10 ** (decimalsA - decimalsB);
}

/**
 * Constant-product swap with fees. Used only for fast discovery ranking; the
 * executable minimum is always re-derived by the SDK quoter before signing.
 */
export function quoteExactInConstantProduct(input: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  feeRatePpm: number;
}): bigint {
  const { amountIn, reserveIn, reserveOut, feeRatePpm } = input;
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const netIn = (amountIn * BigInt(1_000_000 - feeRatePpm)) / 1_000_000n;
  const numerator = netIn * reserveOut;
  const denominator = reserveIn + netIn;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/** Minimal base58 decoder (32-byte keys only) to avoid a runtime dependency here. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58ToBytes(value: string): Buffer {
  let num = 0n;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base58 character: ${char}`);
    num = num * 58n + BigInt(index);
  }
  const hex = num === 0n ? '' : num.toString(16).padStart(64, '0');
  const bytes = Buffer.from(hex, 'hex');
  const padding = value.length - value.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(padding), bytes]);
}

/** Minimal base58 encoder for 32-byte keys (no runtime dependency here). */
export function base58FromBytes(bytes: Buffer): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    out = ALPHABET[remainder] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}
