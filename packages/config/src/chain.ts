/**
 * packages/config/chain — the chain binding file (config/mainnet.solana.yaml).
 *
 * The YAML is a *shape contract*: unresolved values stay as the literal string
 * `REQUIRED_OWNER_BINDING` and validation refuses to start a live lane while
 * any remain (V6 §14). This prevents an "enabled by accident" mainnet.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { SOLANA_MAINNET_GENESIS } from '../../domain/src';

export const UNRESOLVED = 'REQUIRED_OWNER_BINDING';

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana address');

const poolBindingSchema = z.object({
  address: base58,
  mintA: base58,
  mintB: base58,
  decimalsA: z.number().int().min(0).max(18),
  decimalsB: z.number().int().min(0).max(18),
  tickSpacing: z.number().int().positive(),
  feeRatePpm: z.number().int().min(0).max(100_000),
});

export const ChainConfigSchema = z
  .object({
    schemaVersion: z.literal('v6.0'),
    chain: z.object({
      genesisHash: z.string().refine((v) => v === SOLANA_MAINNET_GENESIS || v === UNRESOLVED, {
        message: `genesisHash must be Solana mainnet (${SOLANA_MAINNET_GENESIS})`,
      }),
      enabled: z.boolean(),
      settlementMint: base58,
      txFormat: z.enum(['v0', 'v1']),
      commitment: z.enum(['confirmed', 'finalized']),
    }),
    lender: z.object({
      kind: z.literal('JUPITER_LEND'),
      programId: z.string(),
      sdkVersion: z.string(),
      // Jupiter Lend flash composition is not proven against a live program in
      // this release, so the adapter must be explicitly disabled.
      enabled: z.boolean(),
    }),
    executor: z.object({
      operatorPublicAddress: z.string(),
      treasuryAddress: z.string(),
      maxComputeUnits: z.number().int().min(50_000).max(1_400_000),
      priorityFeeMicroLamports: z.number().int().min(0),
    }),
    market: z.object({
      programId: base58,
      pools: z.array(poolBindingSchema).min(2),
      // A feed older than this is never used to build a transaction.
      maxQuoteAgeMs: z.number().int().min(50).max(60_000),
      // Subscription resubscribe backoff.
      reconnectBaseMs: z.number().int().min(100).max(60_000),
      reconnectMaxMs: z.number().int().min(500).max(300_000),
      // Detects a stalled stream rather than waiting forever.
      healthCheckIntervalMs: z.number().int().min(1_000).max(120_000),
    }),
    control: z.object({
      independentEmergencyStop: z.string(),
      alertTargetRef: z.string(),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.chain.enabled && cfg.chain.genesisHash === UNRESOLVED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chain cannot be enabled while genesisHash is unresolved',
        path: ['chain', 'genesisHash'],
      });
    }
    const seen = new Set<string>();
    for (const pool of cfg.market.pools) {
      if (seen.has(pool.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate pool ${pool.address} — a route needs two distinct pools`,
          path: ['market', 'pools'],
        });
      }
      seen.add(pool.address);
      if (pool.mintA === pool.mintB) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pool ${pool.address} has identical mints`,
          path: ['market', 'pools'],
        });
      }
      if (![pool.mintA, pool.mintB].includes(cfg.chain.settlementMint)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pool ${pool.address} does not contain the settlement mint`,
          path: ['market', 'pools'],
        });
      }
    }
  });

export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export function parseChainConfig(raw: unknown): ChainConfig {
  const parsed = ChainConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid chain config: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function loadChainConfig(path: string): ChainConfig {
  const text = readFileSync(path, 'utf8');
  return parseChainConfig(YAML.parse(text));
}
