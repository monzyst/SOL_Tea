/**
 * packages/config/policy — signed financial policy (config/policy.solana.yaml).
 *
 * Every numeric bound here is an owner decision. The code refuses to run a live
 * lane while any bound is still `REQUIRED_OWNER_BINDING`, and the reservation
 * ledger enforces them on every attempt (V6 §06).
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { UNRESOLVED } from './chain';

/** Accepts either a resolved non-negative integer (or digit string) or the placeholder. */
const ownerBound = z.union([
  z.literal(UNRESOLVED),
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^[0-9]+$/, 'must be a non-negative integer string')
    .transform((v) => Number(v)),
]);

export const PolicySchema = z
  .object({
    schemaVersion: z.literal('v6.0'),
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
      // Cool-down after a failed/unknown attempt on the same route.
      routeCooldownMs: z.number().int().min(0).max(600_000),
      // Repeated failures quarantine a route rather than burning fees.
      maxConsecutiveFailures: z.number().int().min(1).max(100),
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
    if (p.periodStartUtc !== UNRESOLVED && Number.isNaN(Date.parse(p.periodStartUtc))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'periodStartUtc must be an ISO-8601 UTC timestamp',
        path: ['solArb', 'periodStartUtc'],
      });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;

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

/** Every money-moving bound must be resolved before live signing is possible. */
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
