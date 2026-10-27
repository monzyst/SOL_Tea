/**
 * packages/config — strict environment contract.
 *
 * Every field is validated before the process touches the chain. There is no
 * permissive default for anything that can move money: an empty
 * WALLET_KEYPAIR_PATH is *valid* (observe-only mode) but cannot sign, and
 * ENABLE_LIVE_EXECUTION must be explicitly "true" for any submission.
 *
 * Secrets are never read from a committed file: they come from the environment
 * or from a path outside the repository (V6 §14).
 */

import { z } from 'zod';

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((v) => v === 'true');

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))
  .refine((v) => v === undefined || /^(https|wss):\/\/.+/.test(v), {
    message: 'must be empty or an absolute https/wss URL',
  });

export const EnvSchema = z
  .object({
    RPC_HTTP_URL: z
      .string()
      .trim()
      .refine((v) => /^https:\/\/.+/.test(v), { message: 'RPC_HTTP_URL must be an https URL' }),
    RPC_WS_URL: z
      .string()
      .trim()
      .refine((v) => /^wss?:\/\/.+/.test(v), { message: 'RPC_WS_URL must be a ws(s) URL' }),
    RPC_HTTP_URL_SECONDARY: optionalUrl,
    RPC_WS_URL_SECONDARY: optionalUrl,

    WALLET_KEYPAIR_PATH: z.string().trim().default(''),
    OPERATOR_PUBLIC_ADDRESS: z.string().trim().default(''),
    /** Deployment secret used to derive the signer payload-store key. */
    SIGNER_STORE_KEY: z.string().default(''),
    /** Bearer token that the signer HTTP service requires. */
    SIGNER_SERVICE_TOKEN: z.string().default(''),

    SOL_TEA_CHAIN_CONFIG: z.string().trim().default('config/mainnet.solana.yaml'),
    SOL_TEA_POLICY_CONFIG: z.string().trim().default('config/policy.solana.yaml'),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_PRETTY: boolish.default('false'),
    /** Structured logs are JSON on stdout; this is the service label in them. */
    SERVICE_NAME: z.string().trim().default('sol-tea'),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    JOURNAL_DIR: z.string().trim().default('var/journal'),
    /** Durable state of record. One file per deployment; see docs/ARCHITECTURE.md. */
    STORE_PATH: z.string().trim().default('var/state/sol-tea.db'),
    /** Per-call RPC deadline. Bounds how long a hung provider can stall a round. */
    RPC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

    ENABLE_LIVE_EXECUTION: boolish.default('false'),
    EMERGENCY_PAUSE: boolish.default('false'),
    /** Webhook for operator alerts. Empty disables remote alerting. */
    ALERT_WEBHOOK_URL: z.string().trim().default(''),

    /** Max slot difference tolerated between the two legs of a route. */
    MAX_SKEW_SLOTS: z.coerce.number().int().min(1).max(500).default(25),
  })
  .superRefine((env, ctx) => {
    // A secondary provider must be declared as a pair, otherwise failover would
    // silently degrade to "the same backend twice".
    if (!!env.RPC_HTTP_URL_SECONDARY !== !!env.RPC_WS_URL_SECONDARY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RPC_HTTP_URL_SECONDARY and RPC_WS_URL_SECONDARY must be set together',
        path: ['RPC_HTTP_URL_SECONDARY'],
      });
    }
    if (env.RPC_HTTP_URL_SECONDARY && env.RPC_HTTP_URL_SECONDARY === env.RPC_HTTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secondary RPC must be a distinct endpoint, not the primary repeated',
        path: ['RPC_HTTP_URL_SECONDARY'],
      });
    }
    if (env.ENABLE_LIVE_EXECUTION && env.WALLET_KEYPAIR_PATH === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ENABLE_LIVE_EXECUTION=true requires WALLET_KEYPAIR_PATH',
        path: ['WALLET_KEYPAIR_PATH'],
      });
    }
    // A signer that can submit but cannot attest payloads is half-configured;
    // refuse rather than degrade to an unauthenticated store.
    if (env.ENABLE_LIVE_EXECUTION && env.SIGNER_STORE_KEY.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ENABLE_LIVE_EXECUTION=true requires SIGNER_STORE_KEY (>=16 chars)',
        path: ['SIGNER_STORE_KEY'],
      });
    }
    if (env.SIGNER_STORE_KEY !== '' && env.SIGNER_STORE_KEY.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SIGNER_STORE_KEY must be at least 16 characters',
        path: ['SIGNER_STORE_KEY'],
      });
    }
    if (env.ALERT_WEBHOOK_URL !== '' && !/^https:\/\/.+/.test(env.ALERT_WEBHOOK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ALERT_WEBHOOK_URL must be an https URL',
        path: ['ALERT_WEBHOOK_URL'],
      });
    }
    // A keypair must never be loaded from inside the repository tree.
    if (env.WALLET_KEYPAIR_PATH !== '' && !env.WALLET_KEYPAIR_PATH.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WALLET_KEYPAIR_PATH must be an absolute path outside the repository',
        path: ['WALLET_KEYPAIR_PATH'],
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(`${message}: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError('invalid environment configuration', issues);
  }
  return parsed.data;
}

/** Execution is possible only when live mode is on AND the emergency stop is clear. */
export function executionAllowed(env: Env): boolean {
  return env.ENABLE_LIVE_EXECUTION && !env.EMERGENCY_PAUSE;
}
