/**
 * packages/config/policy — signed financial policy (config/policy.solana.yaml).
 *
 * The distinction that matters: `REQUIRED_OWNER_BINDING` is NOT a default. It is
 * an explicit statement that the owner has not yet authorised this lane. The
 * validator accepts the file so the engine can boot observe-only, and
 * `unresolvedPolicyFields` reports exactly what is missing. Nothing here ever
 * guesses a capital limit — guessing a position size is how an engine loses
 * money while looking correctly configured.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './env';
import { REQUIRED } from './chain';

/** A bound is either an explicit integer or the explicit "not yet decided" mark. */
const bound = z.union([z.literal(REQUIRED), z.number().int().min(0)]);

const boundWithUnit = z.object({
  value: bound,
  unit: z.enum(['RAW', 'LAMPORTS', 'BPS', 'MS', 'UTC', 'COUNT']),
});

export const policySchema = z.object({
  schemaVersion: z.literal('v6.0'),
  solArb: z.object({
    maxBorrowRaw: bound,
    minPrincipalRawPerAttempt: bound,
    maxPrincipalRawPerAttempt: bound,
    minOnchainSurplusRaw: bound,
    minEconomicNetRaw: bound,
    maxSlippageBps: z.number().int().min(0).max(2_000),
    maxNativeFeePerAttemptLamports: bound,
    maxNativeFeePeriodLamports: bound,
    periodStartUtc: z.union([z.literal(REQUIRED), z.string().datetime({ offset: true })]),
    maxConcurrentPending: bound,
    routeCooldownMs: z.number().int().min(0),
    maxConsecutiveFailures: z.number().int().min(1),
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
    maxDailyLossRaw: bound,
  }),
});

export type Policy = z.infer<typeof policySchema>;

export function loadPolicy(path: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError('policy-config', [`cannot read ${path}: ${(error as Error).message}`]);
  }

  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      'policy-config',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const policy = parsed.data;
  const issues: string[] = [];

  // A structurally impossible policy is rejected even in observe-only mode:
  // these describe relationships, not amounts, so no owner decision is implied.
  if (
    typeof policy.solArb.minPrincipalRawPerAttempt === 'number' &&
    typeof policy.solArb.maxPrincipalRawPerAttempt === 'number' &&
    policy.solArb.minPrincipalRawPerAttempt > policy.solArb.maxPrincipalRawPerAttempt
  ) {
    issues.push('solArb.minPrincipalRawPerAttempt: must be <= maxPrincipalRawPerAttempt');
  }
  if (
    typeof policy.solArb.maxNativeFeePerAttemptLamports === 'number' &&
    typeof policy.solArb.maxNativeFeePeriodLamports === 'number' &&
    policy.solArb.maxNativeFeePerAttemptLamports > policy.solArb.maxNativeFeePeriodLamports
  ) {
    issues.push(
      'solArb.maxNativeFeePerAttemptLamports: cannot exceed maxNativeFeePeriodLamports',
    );
  }
  if (policy.solArb.maxConcurrentPending === 0) {
    issues.push('solArb.maxConcurrentPending: a zero limit would make the engine inert');
  }

  if (issues.length > 0) throw new ConfigError('policy-config', issues);
  return policy;
}

/** Every field still marked REQUIRED_OWNER_BINDING, in a stable order. */
export function unresolvedPolicyFields(policy: Policy): string[] {
  const fields: string[] = [];
  const check = (name: string, value: unknown): void => {
    if (value === REQUIRED) fields.push(name);
  };

  check('solArb.maxBorrowRaw', policy.solArb.maxBorrowRaw);
  check('solArb.minPrincipalRawPerAttempt', policy.solArb.minPrincipalRawPerAttempt);
  check('solArb.maxPrincipalRawPerAttempt', policy.solArb.maxPrincipalRawPerAttempt);
  check('solArb.minOnchainSurplusRaw', policy.solArb.minOnchainSurplusRaw);
  check('solArb.minEconomicNetRaw', policy.solArb.minEconomicNetRaw);
  check('solArb.maxNativeFeePerAttemptLamports', policy.solArb.maxNativeFeePerAttemptLamports);
  check('solArb.maxNativeFeePeriodLamports', policy.solArb.maxNativeFeePeriodLamports);
  check('solArb.periodStartUtc', policy.solArb.periodStartUtc);
  check('solArb.maxConcurrentPending', policy.solArb.maxConcurrentPending);
  check('control.maxDailyLossRaw', policy.control.maxDailyLossRaw);

  return fields;
}

/** Read an integer bound that the caller has already proven to be resolved. */
export function resolvedNumber(value: number | string, field: string): number {
  if (typeof value !== 'number') {
    throw new ConfigError('policy-config', [`${field}: still unresolved (${String(value)})`]);
  }
  return value;
}
