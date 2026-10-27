/**
 * packages/domain — immutable value types shared by every module.
 *
 * Rules encoded here, not repeated in each caller:
 *  - money is an integer amount in base units, never a float
 *  - an asset is an identity (chain + mint + token program + decimals), so two
 *    things called "USDC" are not automatically interchangeable
 *  - costs round UP, proceeds round DOWN — the only safe direction
 */

export type ChainId = 'solana-mainnet';
export type TokenProgram = 'spl-token' | 'spl-token-2022';
export type DexFamily = 'ORCA_WHIRLPOOL' | 'RAYDIUM_CLMM';
export type PoolVersion = 'v1' | 'v2';

export interface AssetId {
  readonly chain: ChainId;
  readonly mint: string;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
}

export interface Amount<A extends AssetId = AssetId> {
  readonly asset: A;
  readonly raw: bigint;
}

export class DomainError extends Error {
  constructor(
    readonly code:
      | 'ASSET_MISMATCH'
      | 'NEGATIVE_AMOUNT'
      | 'NEGATIVE_RESULT'
      | 'DIVIDE_BY_ZERO'
      | 'INVALID_SLIPPAGE'
      | 'SAME_POOL_ROUTE',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function sameAsset(a: AssetId, b: AssetId): boolean {
  return (
    a.chain === b.chain &&
    a.mint === b.mint &&
    a.tokenProgram === b.tokenProgram &&
    a.decimals === b.decimals
  );
}

export function amount<A extends AssetId>(asset: A, raw: bigint): Amount<A> {
  if (raw < 0n) throw new DomainError('NEGATIVE_AMOUNT', `amount cannot be negative: ${raw}`);
  return { asset, raw };
}

export function addAmount<A extends AssetId>(a: Amount<A>, b: Amount<A>): Amount<A> {
  if (!sameAsset(a.asset, b.asset)) {
    throw new DomainError('ASSET_MISMATCH', `cannot add ${a.asset.mint} and ${b.asset.mint}`);
  }
  return { asset: a.asset, raw: a.raw + b.raw };
}

export function subAmount<A extends AssetId>(a: Amount<A>, b: Amount<A>): Amount<A> {
  if (!sameAsset(a.asset, b.asset)) {
    throw new DomainError('ASSET_MISMATCH', `cannot subtract ${b.asset.mint} from ${a.asset.mint}`);
  }
  if (b.raw > a.raw) {
    throw new DomainError('NEGATIVE_RESULT', `result would be negative: ${a.raw} - ${b.raw}`);
  }
  return { asset: a.asset, raw: a.raw - b.raw };
}

/** Floor division — use for proceeds so we never over-report a gain. */
export function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new DomainError('DIVIDE_BY_ZERO', 'division by zero');
  return (a * b) / denominator;
}

/** Ceiling division — use for costs so we never under-report a spend. */
export function mulDivCeil(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new DomainError('DIVIDE_BY_ZERO', 'division by zero');
  if (a === 0n || b === 0n) return 0n;
  return (a * b - 1n) / denominator + 1n;
}

/** Apply slippage tolerance downwards, producing a minimum acceptable output. */
export function applySlippageFloor(raw: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new DomainError('INVALID_SLIPPAGE', `slippageBps out of range: ${slippageBps}`);
  }
  return mulDivFloor(raw, BigInt(10_000 - slippageBps), 10_000n);
}

/** Rescale between decimal precisions, rounding down (proceeds). */
export function scaleDecimalsFloor(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return raw;
  return fromDecimals < toDecimals
    ? raw * 10n ** BigInt(toDecimals - fromDecimals)
    : raw / 10n ** BigInt(fromDecimals - toDecimals);
}

/** Rescale between decimal precisions, rounding up (costs). */
export function scaleDecimalsCeil(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return raw;
  if (fromDecimals < toDecimals) return raw * 10n ** BigInt(toDecimals - fromDecimals);
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  return raw === 0n ? 0n : (raw - 1n) / divisor + 1n;
}

/* ------------------------------------------------------------- route identity */

export interface RouteIdentity {
  readonly chainId: ChainId;
  readonly settlementMint: string;
  /** Pool we buy the base asset on (settlement -> base). */
  readonly poolBuy: string;
  /** Pool we sell the base asset on (base -> settlement). */
  readonly poolSell: string;
  readonly dexFamilyBuy: DexFamily;
  readonly dexFamilySell: DexFamily;
  readonly poolVersionBuy: PoolVersion;
  readonly poolVersionSell: PoolVersion;
}

/**
 * A route is only a route if the two legs are DIFFERENT pools. Encoding that in
 * the key function means a same-pool "cycle" cannot be represented at all.
 */
export function routeKey(route: RouteIdentity): string {
  if (route.poolBuy === route.poolSell) {
    throw new DomainError('SAME_POOL_ROUTE', 'buy and sell pool must differ');
  }
  return [
    route.chainId,
    route.settlementMint,
    route.dexFamilyBuy,
    route.poolVersionBuy,
    route.poolBuy,
    route.dexFamilySell,
    route.poolVersionSell,
    route.poolSell,
  ].join(':');
}

/* ------------------------------------------------------------------ reason codes */

/**
 * Every ignored update and refused trade carries one of these. "No trade" is
 * never expressed as an empty result — that is how a dead feed looks like a
 * quiet market.
 */
export type ReasonCode =
  | 'OK'
  | 'FEED_STALE'
  | 'FEED_GAP'
  | 'POOL_DEGRADED'
  | 'NO_EDGE_AFTER_FEES'
  | 'SIZE_BELOW_MINIMUM'
  | 'FEE_LIMIT_REACHED'
  | 'MAX_CONCURRENT_PENDING'
  | 'COOLDOWN_AFTER_FAILURE'
  | 'PAUSED'
  | 'POLICY_OR_CODE_DRIFT'
  | 'QUOTES_UNAVAILABLE'
  | 'UNPROVEN_OUTCOME';
