/**
 * packages/config/policy — the financial policy (config/policy.solana.yaml).
 *
 * Two things are true at once here, and keeping them straight matters:
 *
 *  1. The shipped policy is FULLY BOUND. Conservative first-live caps are
 *     defaults, so the engine can actually run live once the operator supplies a
 *     wallet and enables the chain — not blocked behind a placeholder file.
 *  2. The `REQUIRED_OWNER_BINDING` literal is still ACCEPTED by the schema. An
 *     operator who blanks a value back out gets observe-only mode with an explicit
 *     reason, never a crash and never a silent zero. Deleting the placeholder
 *     support to "fix" the limiting factor would have removed the guard that
 *     protects against an accidental unbounded live run.
 *
 * Every numeric bound is an owner decision. The code refuses a live lane while
 * any bound is unresolved, and admission enforces them on every attempt.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { UNRESOLVED } from './chain';

/** Accepts a resolved non-negative integer (or digit string) or the placeholder. */
const ownerBound = z.union([
  z.literal(UNRESOLVED),
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^[0-9]+$/, 'must be a non-negative integer string')
    .transform((v) => Number(v)),
]);

export const PriorityFeePolicySchema = z
  .object({
    /** Percentile of observed priority fees to bid at, 0..1. */
    percentile: z.number().min(0).max(1).default(0.5),
    floorMicroLamports: z.number().int().nonnegative().default(1_000),
    ceilingMicroLamports: z.number().int().positive().default(150_000),
    minSamples: z.number().int().positive().default(8),
    ttlMs: z.number().int().min(1_000).max(300_000).default(15_000),
    /** null = refuse the attempt when there are no samples. */
    fallbackMicroLamports: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((p) => p.ceilingMicroLamports >= p.floorMicroLamports, {
    message: 'ceilingMicroLamports must be >= floorMicroLamports',
    path: ['ceilingMicroLamports'],
  })
  .refine(
    (p) => p.fallbackMicroLamports === null || p.fallbackMicroLamports <= p.ceilingMicroLamports,
    {
      message: 'fallbackMicroLamports must not exceed ceilingMicroLamports',
      path: ['fallbackMicroLamports'],
    },
  );

export const PolicySchema = z
  .object({
    schemaVersion: z.literal('v6.0'),
    defaultsProfile: z
      .object({
        name: z.string().min(1),
        authored: z.string().min(1),
        rationale: z.string().min(1),
        ownerTunable: z.boolean(),
      })
      .optional(),
    solArb: z.object({
      maxBorrowRaw: ownerBound,
      maxPrincipalRawPerAttempt: ownerBound,
      minPrincipalRawPerAttempt: ownerBound,
      minOnchainSurplusRaw: ownerBound,
      minEconomicNetRaw: ownerBound,
      maxSlippageBps: z.number().int().min(0).max(2_000),
      maxNativeFeePerAttemptLamports: ownerBound,
      maxNativeFeePeriodLamports: ownerBound,
      periodStartUtc: z.string(),
      maxConcurrentPending: ownerBound,
      routeCooldownMs: z.number().int().min(0).max(600_000),
      maxConsecutiveFailures: z.number().int().min(1).max(100),
      routeQuarantineMs: z.number().int().min(0).max(86_400_000).default(600_000),
      lenderFeeBps: z.number().int().min(0).max(10_000).default(0),
      priorityFee: PriorityFeePolicySchema.optional(),
    }),
    accounting: z.object({
      reportingCurrency: z.string().min(1),
      rounding: z.object({
        cost: z.literal('CEILING'),
        proceeds: z.literal('FLOOR'),
      }),
    }),
    control: z.object({
      pauseFile: z.string().min(1),
      maxDailyLossRaw: ownerBound,
      independentPause: z
        .object({
          url: z.string().default(''),
          staleAfterMs: z.number().int().min(0).max(86_400_000).default(300_000),
          timeoutMs: z.number().int().min(100).max(30_000).default(3_000),
        })
        .optional(),
    }),
  })
  .superRefine((cfg, ctx) => {
    const p = cfg.solArb;
    if (typeof p.maxBorrowRaw === 'number' && typeof p.maxPrincipalRawPerAttempt === 'number') {
      if (p.maxPrincipalRawPerAttempt > p.maxBorrowRaw) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maxPrincipalRawPerAttempt cannot exceed maxBorrowRaw',
          path: ['solArb', 'maxPrincipalRawPerAttempt'],
        });
      }
    }
    if (
      typeof p.minPrincipalRawPerAttempt === 'number' &&
      typeof p.maxPrincipalRawPerAttempt === 'number' &&
      p.minPrincipalRawPerAttempt > p.maxPrincipalRawPerAttempt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minPrincipalRawPerAttempt exceeds maxPrincipalRawPerAttempt',
        path: ['solArb', 'minPrincipalRawPerAttempt'],
      });
    }
    if (
      typeof p.maxNativeFeePerAttemptLamports === 'number' &&
      typeof p.maxNativeFeePeriodLamports === 'number' &&
      p.maxNativeFeePerAttemptLamports > p.maxNativeFeePeriodLamports
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'per-attempt fee cap exceeds the per-period cap',
        path: ['solArb', 'maxNativeFeePerAttemptLamports'],
      });
    }
    // A net floor below the on-chain floor would let an attempt pass admission
    // while still failing its own on-chain assertion — a guaranteed revert.
    if (typeof p.minEconomicNetRaw === 'number' && typeof p.minOnchainSurplusRaw === 'number') {
      if (p.minEconomicNetRaw < p.minOnchainSurplusRaw) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'minEconomicNetRaw must be >= minOnchainSurplusRaw',
          path: ['solArb', 'minEconomicNetRaw'],
        });
      }
    }
    if (p.periodStartUtc !== UNRESOLVED && Number.isNaN(Date.parse(p.periodStartUtc))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'periodStartUtc must be an ISO-8601 UTC timestamp',
        path: ['solArb', 'periodStartUtc'],
      });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;
export type PriorityFeePolicy = z.infer<typeof PriorityFeePolicySchema>;

export function parsePolicy(raw: unknown): Policy {
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid policy config: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function loadPolicy(path: string): Policy {
  const text = readFileSync(path, 'utf8');
  return parsePolicy(YAML.parse(text));
}

/** Every money-moving bound that is still a placeholder. */
export function unresolvedPolicyFields(policy: Policy): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(policy.solArb)) {
    if (value === UNRESOLVED) out.push(`solArb.${key}`);
  }
  for (const [key, value] of Object.entries(policy.control)) {
    if (value === UNRESOLVED) out.push(`control.${key}`);
  }
  return out;
}

export function resolvedNumber(value: number | string, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${field} is unresolved (${UNRESOLVED}); owner binding required before live execution`);
  }
  return value;
}

/** Resolve a bound, or return null when it is still a placeholder. */
export function maybeNumber(value: number | string): number | null {
  return typeof value === 'number' ? value : null;
}

/** Effective priority-fee policy, with documented defaults filled in. */
export function priorityFeePolicy(policy: Policy): PriorityFeePolicy {
  return (
    policy.solArb.priorityFee ?? {
      percentile: 0.5,
      floorMicroLamports: 1_000,
      ceilingMicroLamports: 150_000,
      minSamples: 8,
      ttlMs: 15_000,
      fallbackMicroLamports: null,
    }
  );
}
