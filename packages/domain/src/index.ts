/**
 * packages/domain — immutable value types shared by every module.
 *
 * Rules enforced here (V6 §05):
 *  - all asset arithmetic is integer base units; floating point is never used
 *    for money,
 *  - an asset identity is (chain, mint, token program, decimals) — never a
 *    bare symbol,
 *  - rounding is explicit: costs ceil, proceeds floor.
 */

export type ChainId = 'solana-mainnet';

/** Solana mainnet genesis hash, independently verifiable via getGenesisHash. */
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export type TokenProgram = 'spl-token' | 'spl-token-2022';

export interface AssetId {
  readonly chain: ChainId;
  readonly mint: string;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
}

export interface Amount {
  readonly asset: AssetId;
  readonly raw: bigint;
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

const BPS_DENOMINATOR = 10_000n;

export function assetId(asset: AssetId): string {
  return `${asset.chain}:${asset.mint}`;
}

export function sameAsset(a: AssetId, b: AssetId): boolean {
  return a.chain === b.chain && a.mint === b.mint && a.tokenProgram === b.tokenProgram;
}

function assertSameAsset(a: AssetId, b: AssetId): void {
  if (!sameAsset(a, b)) {
    throw new DomainError('ASSET_MISMATCH', `cannot combine ${assetId(a)} with ${assetId(b)}`);
  }
}

export function amount(asset: AssetId, raw: bigint): Amount {
  if (raw < 0n) throw new DomainError('NEGATIVE_AMOUNT', `amount must be non-negative: ${raw}`);
  return { asset, raw };
}

export function addAmount(a: Amount, b: Amount): Amount {
  assertSameAsset(a.asset, b.asset);
  return { asset: a.asset, raw: a.raw + b.raw };
}

export function subAmount(a: Amount, b: Amount): Amount {
  assertSameAsset(a.asset, b.asset);
  const raw = a.raw - b.raw;
  if (raw < 0n) throw new DomainError('NEGATIVE_RESULT', 'subtraction would produce a negative amount');
  return { asset: a.asset, raw };
}

/** floor(a * b / d) — proceeds, never rounds up in the trader's favour. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new DomainError('DIVIDE_BY_ZERO', 'mulDivFloor denominator is zero');
  if (a < 0n || b < 0n) throw new DomainError('NEGATIVE_OPERAND', 'mulDivFloor requires non-negative operands');
  return (a * b) / d;
}

/** ceil(a * b / d) — costs, never rounds down. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new DomainError('DIVIDE_BY_ZERO', 'mulDivCeil denominator is zero');
  if (a < 0n || b < 0n) throw new DomainError('NEGATIVE_OPERAND', 'mulDivCeil requires non-negative operands');
  const n = a * b;
  return n === 0n ? 0n : (n + d - 1n) / d;
}

/** Apply a slippage tolerance downward to produce a minimum-output bound. */
export function applySlippageFloor(raw: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new DomainError('INVALID_SLIPPAGE', `slippageBps out of range: ${slippageBps}`);
  }
  return mulDivFloor(raw, BPS_DENOMINATOR - BigInt(slippageBps), BPS_DENOMINATOR);
}

/** Convert a raw amount between decimal scales, flooring. */
export function scaleDecimalsFloor(raw: bigint, sourceDecimals: number, targetDecimals: number): bigint {
  if (targetDecimals >= sourceDecimals) {
    return raw * 10n ** BigInt(targetDecimals - sourceDecimals);
  }
  return raw / 10n ** BigInt(sourceDecimals - targetDecimals);
}

/** Convert a raw amount between decimal scales, ceiling (cost direction). */
export function scaleDecimalsCeil(raw: bigint, sourceDecimals: number, targetDecimals: number): bigint {
  if (targetDecimals >= sourceDecimals) {
    return raw * 10n ** BigInt(targetDecimals - sourceDecimals);
  }
  const d = 10n ** BigInt(sourceDecimals - targetDecimals);
  return raw === 0n ? 0n : (raw + d - 1n) / d;
}

/** Open a base58 encoder/decoder here so no module re-implements it. */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode raw bytes as base58 (Solana wire format for keys and signatures). */
export function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = (B58_ALPHABET[Number(num % 58n)] as string) + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

/** Decode base58 into bytes. Rejects characters outside the alphabet. */
export function decodeBase58(value: string): Buffer {
  let num = 0n;
  for (const char of value) {
    const index = B58_ALPHABET.indexOf(char);
    if (index < 0) throw new DomainError('INVALID_BASE58', `invalid base58 character: ${char}`);
    num = num * 58n + BigInt(index);
  }
  const hex = num === 0n ? '' : num.toString(16);
  const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
  const leadingZeros = value.length - value.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

/**
 * Route identity: exactly two distinct pools forming a closed asset cycle.
 * A venue name alone is never a route (V6 §01.1).
 */
export interface RouteIdentity {
  readonly chainId: ChainId;
  readonly settlementMint: string;
  readonly poolBuy: string;
  readonly poolSell: string;
  readonly dexFamilyBuy: string;
  readonly dexFamilySell: string;
  readonly poolVersionBuy: string;
  readonly poolVersionSell: string;
}

export function routeKey(route: RouteIdentity): string {
  if (route.poolBuy === route.poolSell) {
    throw new DomainError('INVALID_ROUTE', 'spatial route requires two distinct pools');
  }
  return [
    route.chainId,
    route.settlementMint,
    route.poolBuy,
    route.poolSell,
    route.poolVersionBuy,
    route.poolVersionSell,
  ].join('|');
}

/**
 * Funnel reason codes. Every rejected opportunity names exactly one so the
 * operator can always answer "why did nothing trade?" (V6 §10.1).
 */
export type ReasonCode =
  | 'OK'
  | 'FEED_STALE'
  | 'FEED_GAP'
  | 'QUOTES_UNAVAILABLE'
  | 'NO_EDGE_AFTER_FEES'
  | 'SIZE_BELOW_MINIMUM'
  | 'LENDER_NO_LIQUIDITY'
  | 'BUILDER_UNSUPPORTED'
  | 'SIGNER_INTENT_MISMATCH'
  | 'FEE_LIMIT_REACHED'
  | 'MAX_CONCURRENT_PENDING'
  | 'PAUSED'
  /** Economics passed but this process is not armed to submit. */
  | 'LIVE_EXECUTION_DISARMED'
  | 'GAS_BELOW_BOOTSTRAP_FLOOR'
  | 'TX_OUTCOME_UNKNOWN'
  | 'COOLDOWN_AFTER_FAILURE'
  | 'POLICY_OR_CODE_DRIFT'
  /** Fee estimator has no fresh sample and cannot price the attempt. */
  | 'FEE_ESTIMATE_UNAVAILABLE'
  /** Route would cross a liquidity boundary the quote cannot model. */
  | 'TICK_BOUNDARY_CROSSED'
  /** Venue state disagrees with the qualified binding (mints/fee/spacing). */
  | 'VENUE_STATE_DRIFT'
  /** Reference table is stale/short, so the route is unpriceable. */
  | 'LIQUIDITY_UNREFERENCED';

export type AttemptState =
  | 'DISCOVERED'
  | 'QUOTED'
  | 'ADMITTED'
  | 'RESERVED'
  | 'SIGNED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'INCLUDED'
  | 'AWAITING_FINALITY'
  | 'FINALIZED'
  | 'RECONCILED'
  | 'REJECTED'
  | 'FAILED';

export interface TradeIntent {
  readonly intentId: string;
  readonly route: RouteIdentity;
  readonly principalRaw: bigint;
  readonly minOnchainSurplusRaw: bigint;
  readonly minEconomicNetRaw: bigint;
  readonly quotedAtUtc: string;
  readonly evidenceRefs: readonly string[];
}

/** Monotonic, host-scoped intent id. */
export function makeIntentId(hostId: string, bootId: string, counter: number): string {
  return `${hostId}:${bootId}:${counter.toString(36)}`;
}
