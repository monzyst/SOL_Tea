/**
 * packages/config — strict environment contract.
 *
 * Every field is validated once, at boot, and fails fast with the exact variable
 * name. There are no silent defaults for anything that can move money or point
 * at a network: a missing RPC URL is a startup error, not a fallback to a public
 * endpoint that happens to work in development.
 */

import { z } from 'zod';

export const LIVE_EXECUTION_OFF = 'false';

const booleanString = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const httpUrl = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'must start with http:// or https://',
  });

const wsUrl = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
    message: 'must start with ws:// or wss://',
  });

export const envSchema = z
  .object({
    RPC_HTTP_URL: httpUrl,
    RPC_WS_URL: wsUrl,
    // Empty string means "no secondary provider configured".
    RPC_HTTP_URL_SECONDARY: z.string().trim().default(''),
    RPC_WS_URL_SECONDARY: z.string().trim().default(''),

    // Signer material is a PATH, never a key. Empty means observe-only.
    WALLET_KEYPAIR_PATH: z.string().trim().default(''),
    OPERATOR_PUBLIC_ADDRESS: z.string().trim().default(''),

    SOL_TEA_CHAIN_CONFIG: z.string().trim().min(1).default('config/mainnet.solana.yaml'),
    SOL_TEA_POLICY_CONFIG: z.string().trim().min(1).default('config/policy.solana.yaml'),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_PRETTY: booleanString.default('false'),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    JOURNAL_DIR: z.string().trim().min(1).default('var/journal'),

    ENABLE_LIVE_EXECUTION: booleanString.default('false'),
    EMERGENCY_PAUSE: booleanString.default('false'),
  })
  .superRefine((value, ctx) => {
    // A secondary provider is only useful if BOTH its endpoints are present.
    const hasHttp = value.RPC_HTTP_URL_SECONDARY !== '';
    const hasWs = value.RPC_WS_URL_SECONDARY !== '';
    if (hasHttp !== hasWs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasHttp ? 'RPC_WS_URL_SECONDARY' : 'RPC_HTTP_URL_SECONDARY'],
        message: 'secondary provider needs both RPC_HTTP_URL_SECONDARY and RPC_WS_URL_SECONDARY',
      });
    }
    if (hasHttp && !/^https?:\/\//.test(value.RPC_HTTP_URL_SECONDARY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RPC_HTTP_URL_SECONDARY'],
        message: 'must start with http:// or https://',
      });
    }
    if (hasWs && !/^wss?:\/\//.test(value.RPC_WS_URL_SECONDARY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RPC_WS_URL_SECONDARY'],
        message: 'must start with ws:// or wss://',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(
    readonly section: string,
    readonly issues: readonly string[],
  ) {
    super(`${section} invalid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse the process environment. Throws with every problem at once. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      'environment',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Live signing needs BOTH the env switch and the chain switch, plus a resolved
 * policy (checked by the caller). Keeping this in one place means no code path
 * can accidentally decide it is live on its own.
 */
export function executionAllowed(env: Env): boolean {
  return env.ENABLE_LIVE_EXECUTION && !env.EMERGENCY_PAUSE;
}
