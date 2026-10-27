/**
 * packages/registry — versioned, *qualified* network/asset/pool metadata.
 *
 * Nothing here is a promise about the future: every pool carries
 * `qualifiedAt`, `observedProgramIdentity` and `sourceProofRefs`, and the market
 * layer re-qualifies against live account data before a route is used
 * (V6 §11 drift invalidation).
 *
 * The pool addresses below are real Solana mainnet Whirlpool accounts observed
 * during registry construction. They are *observations*, not approval:
 * enabling a live lane still requires owner sign-off under the V6 PRE-LIVE gate.
 */

import type { AssetId } from '../../domain/src';

export const WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/** Canonical Solana mainnet asset identities. */
export const WSOL: AssetId = {
  chain: 'solana-mainnet',
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'spl-token',
  decimals: 9,
};

export const USDC: AssetId = {
  chain: 'solana-mainnet',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenProgram: 'spl-token',
  decimals: 6,
};

export interface PoolBinding {
  /** Pool account address on Solana mainnet. */
  readonly address: string;
  readonly dexFamily: 'orca-whirlpool';
  readonly programId: string;
  /** Account-data layout version this adapter was written against. */
  readonly poolVersion: 'whirlpool-v1';
  readonly mintA: string;
  readonly mintB: string;
  readonly decimalsA: number;
  readonly decimalsB: number;
  readonly tickSpacing: number;
  readonly feeRatePpm: number;
  /** UTC ISO timestamp of the last successful on-chain qualification. */
  readonly qualifiedAt: string;
  /** Identifier of the deployed program observed at qualification time. */
  readonly observedProgramIdentity: string;
  readonly sourceProofRefs: readonly string[];
  readonly maxAgeMs: number;
}

/**
 * Two real, distinct mainnet WSOL/USDC whirlpools with different fee tiers.
 * Distinct pools with verified reserves and a closed cycle are the minimal
 * economic definition of a spatial route (V6 §00).
 */
export const POOL_W_SOL_USDC_400: PoolBinding = {
  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  dexFamily: 'orca-whirlpool',
  programId: WHIRLPOOL_PROGRAM_ID,
  poolVersion: 'whirlpool-v1',
  mintA: WSOL.mint,
  mintB: USDC.mint,
  decimalsA: WSOL.decimals,
  decimalsB: USDC.decimals,
  tickSpacing: 4,
  feeRatePpm: 400,
  qualifiedAt: '2026-10-27T06:58:00.000Z',
  observedProgramIdentity: 'whirlpool-program:whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  sourceProofRefs: ['mainnet:getAccountInfo:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'],
  // Re-qualification window; a stale binding must not be traded (V6 §11).
  maxAgeMs: 30 * 60_000,
};

export const POOL_W_SOL_USDC_500: PoolBinding = {
  address: '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm',
  dexFamily: 'orca-whirlpool',
  programId: WHIRLPOOL_PROGRAM_ID,
  poolVersion: 'whirlpool-v1',
  mintA: WSOL.mint,
  mintB: USDC.mint,
  decimalsA: WSOL.decimals,
  decimalsB: USDC.decimals,
  tickSpacing: 8,
  feeRatePpm: 500,
  qualifiedAt: '2026-10-27T06:58:00.000Z',
  observedProgramIdentity: 'whirlpool-program:whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  sourceProofRefs: ['mainnet:getAccountInfo:7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm'],
  maxAgeMs: 30 * 60_000,
};

export interface RegistrySnapshot {
  readonly pools: ReadonlyMap<string, PoolBinding>;
  readonly assets: ReadonlyMap<string, AssetId>;
  readonly takenAtUtc: string;
}

export function buildRegistrySnapshot(
  pools: readonly PoolBinding[],
  assets: readonly AssetId[],
  nowUtc: Date = new Date(),
): RegistrySnapshot {
  const poolMap = new Map<string, PoolBinding>();
  for (const pool of pools) {
    if (poolMap.has(pool.address)) throw new Error(`duplicate pool in registry: ${pool.address}`);
    poolMap.set(pool.address, pool);
  }
  const assetMap = new Map<string, AssetId>();
  for (const asset of assets) assetMap.set(asset.mint, asset);
  return { pools: poolMap, assets: assetMap, takenAtUtc: nowUtc.toISOString() };
}

/** A binding is usable only while fresh (its program identity is re-checked live). */
export function isPoolFresh(pool: PoolBinding, nowUtc: Date): boolean {
  const qualified = Date.parse(pool.qualifiedAt);
  if (Number.isNaN(qualified)) return false;
  const ageMs = nowUtc.getTime() - qualified;
  return ageMs >= 0 && ageMs <= pool.maxAgeMs;
}

export function defaultRegistry(nowUtc: Date = new Date()): RegistrySnapshot {
  return buildRegistrySnapshot([POOL_W_SOL_USDC_400, POOL_W_SOL_USDC_500], [WSOL, USDC], nowUtc);
}
