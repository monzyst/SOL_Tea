/**
 * packages/config/chain — the chain binding file (config/mainnet.solana.yaml).
 *
 * The YAML is a *shape contract*: unresolved values stay as the literal string
 * `REQUIRED_OWNER_BINDING`, and validation refuses to start a LIVE lane while any
 * remain (V6 §14). This prevents an "enabled by accident" mainnet.
 *
 * `executionMode` is an explicit three-way choice rather than a boolean because
 * "build and sign but do not submit" is the only safe way to prove the signing
 * path, and a boolean forces operators to jump straight from nothing to live.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { SOLANA_MAINNET_GENESIS } from '../../domain/src';

export const UNRESOLVED = 'REQUIRED_OWNER_BINDING';

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana address');

/** A base58 key, or the placeholder while an owner binding is outstanding. */
const base58OrUnresolved = z.union([z.literal(UNRESOLVED), base58]);

export type ExecutionMode = 'observe' | 'dry-run' | 'live';

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
      executionMode: z.enum(['observe', 'dry-run', 'live']).default('observe'),
    }),
    lender: z.object({
      kind: z.enum(['JUPITER_LEND', 'NONE']),
      programId: base58OrUnresolved,
      sdkVersion: z.string(),
      enabled: z.boolean(),
      feeBps: z.number().int().min(0).max(10_000).default(0),
    }),
    guard: z
      .object({
        programId: base58OrUnresolved,
        enabled: z.boolean(),
        closeAfterAttempt: z.boolean().default(true),
      })
      .optional(),
    executor: z.object({
      operatorPublicAddress: base58OrUnresolved,
      treasuryAddress: base58OrUnresolved,
      maxComputeUnits: z.number().int().min(50_000).max(1_400_000),
      priorityFeeMicroLamports: z.number().int().min(0),
      maxQuoteAgeMs: z.number().int().min(100).max(60_000).default(2_500),
    }),
    store: z
      .object({
        path: z.string().min(1).default('var/state/sol-tea.db'),
        busyTimeoutMs: z.number().int().min(0).max(120_000).default(5_000),
      })
      .default({ path: 'var/state/sol-tea.db', busyTimeoutMs: 5_000 }),
    market: z.object({
      programId: base58,
      pools: z.array(poolBindingSchema).min(2),
      maxQuoteAgeMs: z.number().int().min(50).max(60_000),
      liquidityMapMaxAgeMs: z.number().int().min(100).max(120_000).default(4_000),
      liquidityMapSpan: z.number().int().min(1).max(6).default(2),
      reconnectBaseMs: z.number().int().min(100).max(60_000),
      reconnectMaxMs: z.number().int().min(500).max(300_000),
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
    // A live lane needs a wallet identity and a lender/guard that exist. These
    // are checked at config load so a half-bound lane cannot boot into `live`.
    if (cfg.chain.executionMode === 'live') {
      if (!cfg.chain.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'executionMode=live requires chain.enabled=true',
          path: ['chain', 'enabled'],
        });
      }
      if (cfg.executor.operatorPublicAddress === UNRESOLVED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'executionMode=live requires executor.operatorPublicAddress',
          path: ['executor', 'operatorPublicAddress'],
        });
      }
    }
    if (cfg.lender.enabled && cfg.lender.programId === UNRESOLVED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'lender.enabled requires a pinned lender programId',
        path: ['lender', 'programId'],
      });
    }
    if (cfg.guard?.enabled && cfg.guard.programId === UNRESOLVED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'guard.enabled requires a deployed guard programId',
        path: ['guard', 'programId'],
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

/** Unresolved owner bindings in the chain file, with their field paths. */
export function unresolvedChainFields(config: ChainConfig): string[] {
  const out: string[] = [];
  if (config.chain.genesisHash === UNRESOLVED) out.push('chain.genesisHash');
  if (config.executor.operatorPublicAddress === UNRESOLVED) out.push('executor.operatorPublicAddress');
  if (config.executor.treasuryAddress === UNRESOLVED) out.push('executor.treasuryAddress');
  if (config.control.alertTargetRef === UNRESOLVED) out.push('control.alertTargetRef');
  if (config.lender.programId === UNRESOLVED) out.push('lender.programId');
  if (config.guard?.programId === UNRESOLVED) out.push('guard.programId');
  return out;
}

/**
 * Whether live submission is permitted.
 *
 * Four independent conditions, all required. Keeping this a single named function
 * means there is exactly one place in the codebase that can answer "may we send a
 * transaction", which is auditable in a way that scattered boolean checks are not.
 */
export function liveSubmissionAllowed(input: {
  config: ChainConfig;
  envLiveEnabled: boolean;
  envPaused: boolean;
  unresolvedPolicy: readonly string[];
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.config.chain.executionMode !== 'live') {
    reasons.push(`executionMode is ${input.config.chain.executionMode}`);
  }
  if (!input.config.chain.enabled) reasons.push('chain.enabled is false');
  if (!input.envLiveEnabled) reasons.push('ENABLE_LIVE_EXECUTION is false');
  if (input.envPaused) reasons.push('EMERGENCY_PAUSE is set');
  if (input.unresolvedPolicy.length > 0) {
    reasons.push(`${input.unresolvedPolicy.length} unresolved policy bindings`);
  }
  if (input.config.lender.enabled === false) reasons.push('lender is disabled (own-capital mode)');
  if (input.config.guard?.enabled !== true) reasons.push('guard program is not enabled');
  return { allowed: reasons.length === 0, reasons };
}
