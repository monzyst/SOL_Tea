/**
 * packages/config/chain — the chain binding file (config/mainnet.solana.yaml).
 *
 * This file is the single place where network identity lives. It is validated
 * with the same strictness as the environment, and it refuses to accept a
 * genesis hash that does not match the cluster the operator believes they are
 * on: pointing a mainnet config at devnet is a fund-loss bug, not a typo.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './env';

/** Solana mainnet-beta genesis hash. Verified via RPC getGenesisHash. */
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Placeholder that must be replaced by an explicit owner decision. */
export const REQUIRED = 'REQUIRED_OWNER_BINDING';

export const poolSchema = z.object({
  address: z.string().min(32),
  mintA: z.string().min(32),
  mintB: z.string().min(32),
  decimalsA: z.number().int().min(0).max(18),
  decimalsB: z.number().int().min(0).max(18),
  tickSpacing: z.number().int().positive(),
  feeRatePpm: z.number().int().min(0).max(100_000),
});

export const chainConfigSchema = z.object({
  schemaVersion: z.literal('v6.0'),
  chain: z.object({
    genesisHash: z.string().min(32),
    enabled: z.boolean(),
    settlementMint: z.string().min(32),
    txFormat: z.enum(['v0', 'legacy']),
    commitment: z.enum(['confirmed', 'finalized']),
  }),
  lender: z.object({
    kind: z.enum(['JUPITER_LEND', 'NONE']),
    programId: z.string().min(1),
    sdkVersion: z.string().min(1),
    enabled: z.boolean(),
  }),
  executor: z.object({
    operatorPublicAddress: z.string().min(1),
    treasuryAddress: z.string().min(1),
    maxComputeUnits: z.number().int().min(1_000).max(1_400_000),
    priorityFeeMicroLamports: z.number().int().min(0).max(1_000_000),
  }),
  market: z.object({
    programId: z.string().min(32),
    // Two DISTINCT pools are structurally required to form a closed cycle.
    pools: z.array(poolSchema).length(2, 'exactly two pools are required'),
    maxQuoteAgeMs: z.number().int().positive(),
    reconnectBaseMs: z.number().int().positive(),
    reconnectMaxMs: z.number().int().positive(),
    healthCheckIntervalMs: z.number().int().positive(),
  }),
  control: z.object({
    independentEmergencyStop: z.string().min(1),
    alertTargetRef: z.string().min(1),
  }),
});

export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type PoolConfig = z.infer<typeof poolSchema>;

export function loadChainConfig(path: string): ChainConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError('chain-config', [`cannot read ${path}: ${(error as Error).message}`]);
  }

  const parsed = chainConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      'chain-config',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const config = parsed.data;
  const issues: string[] = [];

  // Fail closed on cluster mismatch. An unresolved placeholder is reported by
  // the caller as "observe-only"; a WRONG hash is always fatal.
  if (config.chain.genesisHash !== REQUIRED && config.chain.genesisHash !== SOLANA_MAINNET_GENESIS) {
    issues.push(
      `chain.genesisHash: ${config.chain.genesisHash} is not mainnet-beta (${SOLANA_MAINNET_GENESIS})`,
    );
  }

  // A cycle needs two different pools; identical addresses would make the route
  // mathematically impossible and is always a configuration mistake.
  const [first, second] = config.market.pools;
  if (first && second && first.address === second.address) {
    issues.push('market.pools: both entries have the same address');
  }
  if (first && second) {
    for (const pool of [first, second]) {
      if (pool.mintA === pool.mintB) issues.push(`market.pools.${pool.address}: mintA equals mintB`);
      if (pool.mintA !== config.chain.settlementMint && pool.mintB !== config.chain.settlementMint) {
        issues.push(`market.pools.${pool.address}: neither mint is the settlement asset`);
      }
    }
  }

  if (config.market.reconnectMaxMs < config.market.reconnectBaseMs) {
    issues.push('market.reconnectMaxMs: must be >= reconnectBaseMs');
  }

  if (issues.length > 0) throw new ConfigError('chain-config', issues);
  return config;
}
