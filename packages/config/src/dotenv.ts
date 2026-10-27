/**
 * packages/config/dotenv — minimal, dependency-free .env loader.
 *
 * Node does not read .env by itself, and a process that boots to "RPC_HTTP_URL:
 * Required" while a perfectly good .env sits in the working directory is a
 * self-inflicted outage. This loader runs before validation and is deliberately
 * conservative:
 *
 *  - it never overwrites a variable already present in the real environment
 *    (so container/orchestrator secrets always win over a stray file),
 *  - it is silent when the file is absent (CI and production set real env vars),
 *  - it supports the quoting styles .env files actually use.
 *
 * Committed config must never depend on this: `.env` is git-ignored and only
 * carries local/operator overrides.
 */

import { existsSync, readFileSync } from 'node:fs';

/** Parse .env text into key/value pairs without touching the environment. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    // Strip an inline comment only when the value is unquoted.
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash > 0) value = value.slice(0, hash).trim();
    }

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Load a .env file into `env` without overriding anything already set.
 * Returns the keys that were applied, so startup can log them (never values).
 */
export function loadDotEnv(
  filePath = '.env',
  env: NodeJS.ProcessEnv = process.env,
): { loaded: boolean; appliedKeys: string[] } {
  if (!existsSync(filePath)) return { loaded: false, appliedKeys: [] };

  let parsed: Record<string, string>;
  try {
    parsed = parseDotEnv(readFileSync(filePath, 'utf8'));
  } catch {
    // An unreadable .env must not be silently ignored: the caller validates the
    // environment next and will report the missing variables explicitly.
    return { loaded: false, appliedKeys: [] };
  }

  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      appliedKeys.push(key);
    }
  }
  return { loaded: true, appliedKeys };
}
