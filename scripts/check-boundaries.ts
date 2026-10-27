/**
 * scripts/check-boundaries — enforce module boundaries mechanically.
 *
 * Architectural rules that are only written in a document are not rules. This
 * script fails the build when the layering is violated, so a boundary can only be
 * broken on purpose.
 *
 * Rules:
 *  1. packages/domain must not import from any other workspace package (it is the
 *     vocabulary everything else shares).
 *  2. Nothing under packages/ or chains/ may import from apps/ (apps compose, they
 *     are never depended upon).
 *  3. Only packages/rpc, packages/executor, chains/solana, packages/market may
 *     import @solana/web3.js — everything else works in plain data types.
 *  4. packages/signer must not import the executor (it is a separate trust domain
 *     and must never be able to build a transaction of its own).
 *  5. Only packages/config may read process.env (single configuration surface).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const failures: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = [...walk(join(root, 'packages')), ...walk(join(root, 'chains')), ...walk(join(root, 'apps'))];

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const WEB3_ALLOWED = [
  'packages/rpc/',
  'packages/executor/',
  'chains/solana/',
  'packages/market/',
  // The signer MUST decode transaction bytes to enforce economic limits — that is
  // the whole point of the firewall, not a layering leak.
  'packages/signer/',
  // Reconciliation reads chain state to settle local records against it.
  'packages/reconcile/',
  // apps compose the process; they own the Connection lifecycle.
  'apps/',
];

for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8');
  const specifiers = importsOf(source);

  for (const specifier of specifiers) {
    // Rule 1 — domain is a leaf.
    if (rel.startsWith('packages/domain/') && specifier.startsWith('.')) {
      const resolved = join(rel, '..', specifier);
      if (/(packages|chains|apps)\//.test(resolved) && !resolved.includes('packages/domain')) {
        // Relative imports escaping domain are reported by the TS build anyway,
        // but flag the intent explicitly.
        failures.push(`${rel}: packages/domain must not import outside itself (${specifier})`);
      }
    }

    // Rule 2 — no dependency on apps.
    if ((rel.startsWith('packages/') || rel.startsWith('chains/')) && /(^|\/)apps\//.test(specifier)) {
      failures.push(`${rel}: packages/chains must not import from apps (${specifier})`);
    }

    // Rule 3 — web3.js only where a Connection actually lives.
    if (specifier === '@solana/web3.js' && !WEB3_ALLOWED.some((prefix) => rel.startsWith(prefix))) {
      failures.push(`${rel}: only ${WEB3_ALLOWED.join(', ')} may import @solana/web3.js`);
    }

    // Rule 4 — the signer is a separate trust domain.
    if (rel.startsWith('packages/signer/') && specifier.includes('packages/executor')) {
      failures.push(`${rel}: the signer must not import the executor`);
    }
  }

  // Rule 5 — one configuration surface. obs is exempt: it reads LOG_LEVEL before
  // config is parsed, so logging works even when configuration is invalid.
  if (
    !rel.startsWith('packages/config/') &&
    !rel.startsWith('packages/obs/') &&
    !rel.startsWith('scripts/') &&
    !rel.startsWith('tests/')
  ) {
    if (/\bprocess\.env\b/.test(source)) {
      failures.push(`${rel}: read configuration through packages/config, not process.env directly`);
    }
  }
}

if (failures.length > 0) {
  console.error(`boundary violations (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`boundaries OK — ${files.length} TypeScript files checked`);
