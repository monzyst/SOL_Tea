/**
 * packages/config/dotenv — minimal, dependency-free .env loader.
 *
 * Node does not read .env by itself. Without this, `cp .env.example .env`
 * followed by `npm run dev` silently starts against the wrong configuration,
 * which is exactly the class of failure that looks like "the bot ignores my
 * settings".
 *
 * Deliberate behaviour:
 *  - a real environment variable ALWAYS wins over the file
 *  - a missing .env is normal (production uses real env vars)
 *  - nothing is logged at info level: values are not a log concern
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DotEnvResult {
  readonly loaded: boolean;
  readonly path: string;
  /** Variable names applied from the file (never their values). */
  readonly appliedKeys: readonly string[];
}

/** Strip one layer of matching quotes from a raw value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return first === '"' ? inner.replace(/\\n/g, '\n') : inner;
    }
  }
  return trimmed;
}

export function loadDotEnv(path = resolve(process.cwd(), '.env')): DotEnvResult {
  if (!existsSync(path)) return { loaded: false, path, appliedKeys: [] };

  const appliedKeys: string[] = [];
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    // Only a conservative identifier charset; anything else is not a variable.
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;

    // Real environment variables take precedence, so a stale .env can never
    // override what the orchestrator injected.
    if (process.env[key] !== undefined) continue;

    process.env[key] = unquote(line.slice(separator + 1));
    appliedKeys.push(key);
  }

  return { loaded: true, path, appliedKeys };
}
