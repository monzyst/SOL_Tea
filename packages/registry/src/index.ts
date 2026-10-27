/**
 * packages/registry — versioned, *qualified* network/asset/pool metadata.
 *
 * Every address here was read from Solana mainnet-beta and verified on chain
 * (see docs/SOURCE_REGISTER.md). Nothing is guessed and nothing is inferred from
 * a token symbol: a pool is bound by its two mints, and a decode that disagrees
 * with this binding invalidates the route instead of trading it.
 */

import type { AssetId, ChainId, PoolVersion } from '../../domain/src';
import { SOLANA_MAINNET_GENESIS } from '../../config/src/chain';

/** Orca Whirlpool program (mainnet). */
export const WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/** Canonical SPL Token program. */
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const CHAIN_ID: ChainId = 'solana-mainnet';
export const GENESIS_HASH = SOLANA_MAINNET_GENESIS;

export const WSOL: AssetId = {
  chain: CHAIN_ID,
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'spl-token',
  decimals: 9,
};

export const USDC: AssetId = {
  chain: CHAIN_ID,
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenProgram: 'spl-token',
  decimals: 6,
};

export interface PoolBinding {
  readonly address: string;
  readonly dexFamily: 'ORCA_WHIRLPOOL' | 'RAYDIUM_CLMM';
  readonly poolVersion: PoolVersion;
  readonly programId: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly decimalsA: number;
  readonly decimalsB: number;
  readonly tickSpacing: number;
  readonly feeRatePpm: number;
  /** Slot observed when this binding was verified on chain. */
  readonly qualifiedAtSlot: number;
}

/**
 * Pool A — the deep WSOL/USDC Whirlpool (0.04% tier).
 * Verified 2026-10-27: 653-byte account, Whirlpool-owned, tickSpacing 4,
 * feeRate 400, mintA = WSOL, mintB = USDC.
 */
export const POOL_W_SOL_USDC_400: PoolBinding = {
  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  dexFamily: 'ORCA_WHIRLPOOL',
  poolVersion: 'v1',
  programId: WHIRLPOOL_PROGRAM_ID,
  mintA: WSOL.mint,
  mintB: USDC.mint,
  decimalsA: WSOL.decimals,
  decimalsB: USDC.decimals,
  tickSpacing: 4,
  feeRatePpm: 400,
  qualifiedAtSlot: 461_982_568,
};

/**
 * Pool B — a second, distinct WSOL/USDC Whirlpool (0.05% tier).
 * A different fee tier is what makes a spatial cycle possible at all.
 * Verified 2026-10-27: tickSpacing 8, feeRate 500.
 */
export const POOL_W_SOL_USDC_500: PoolBinding = {
  address: '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm',
  dexFamily: 'ORCA_WHIRLPOOL',
  poolVersion: 'v1',
  programId: WHIRLPOOL_PROGRAM_ID,
  mintA: WSOL.mint,
  mintB: USDC.mint,
  decimalsA: WSOL.decimals,
  decimalsB: USDC.decimals,
  tickSpacing: 8,
  feeRatePpm: 500,
  qualifiedAtSlot: 461_982_568,
};

export const ALL_POOL_BINDINGS: readonly PoolBinding[] = [POOL_W_SOL_USDC_400, POOL_W_SOL_USDC_500];

/** Lookup map used on the hot path (no linear scan per update). */
export const POOL_BINDINGS: ReadonlyMap<string, PoolBinding> = new Map(
  ALL_POOL_BINDINGS.map((binding) => [binding.address, binding]),
);

export const ASSETS: ReadonlyMap<string, AssetId> = new Map([
  [WSOL.mint, WSOL],
  [USDC.mint, USDC],
]);
