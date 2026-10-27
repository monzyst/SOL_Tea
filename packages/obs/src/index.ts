/**
 * packages/obs — structured logging, metrics, funnel telemetry, redaction.
 *
 * Three principles:
 *  - every log line is one JSON object, so it is queryable without a parser
 *  - a secret never reaches a log sink, even if a caller passes one by mistake
 *  - the decision funnel counts WHY nothing happened, not just what did
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Patterns that indicate credential material. Applied to every string value
 * before serialisation, because "we do not log secrets" is a policy, and a
 * policy needs an enforcement point.
 */
const REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // base58 blobs long enough to be a secret key
  { pattern: /\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, replacement: '[redacted:base58-blob]' },
  // JSON arrays of 64 small integers — the classic Solana keypair file body
  { pattern: /\[\s*(?:\d{1,3}\s*,\s*){40,}\d{1,3}\s*\]/g, replacement: '[redacted:keypair-array]' },
  // bearer tokens and API keys in query strings
  { pattern: /((?:api[-_]?key|token|secret|password)=)[^&\s"']+/gi, replacement: '$1[redacted]' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replacement: '$1[redacted]' },
  // credentials embedded in a URL
  { pattern: /(\/\/)[^:/@\s]+:[^@\s]+@/g, replacement: '$1[redacted]@' },
];

/** Deep-redact a value destined for a log sink. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (typeof value === 'string') {
    let output = value;
    for (const rule of REDACTIONS) output = output.replace(rule.pattern, rule.replacement);
    return output;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Keys that name secret material are dropped wholesale, regardless of shape.
      if (/^(private|secret|mnemonic|seed|keypair|passphrase)/i.test(key)) {
        output[key] = '[redacted]';
        continue;
      }
      output[key] = redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export interface LoggerOptions {
  readonly component: string;
  readonly level: LogLevel;
  readonly pretty: boolean;
  /** Injection point for tests; defaults to stdout. */
  readonly sink?: (line: string) => void;
  readonly nowUtc?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const nowUtc = options.nowUtc ?? (() => new Date());

  const emit = (level: LogLevel, component: string, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = {
      ts: nowUtc().toISOString(),
      level,
      component,
      event,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(options.pretty ? formatPretty(record) : JSON.stringify(record));
  };

  const make = (component: string): Logger => ({
    debug: (event, fields) => emit('debug', component, event, fields),
    info: (event, fields) => emit('info', component, event, fields),
    warn: (event, fields) => emit('warn', component, event, fields),
    error: (event, fields) => emit('error', component, event, fields),
    child: (child) => make(`${component}.${child}`),
  });

  return make(options.component);
}

function formatPretty(record: Record<string, unknown>): string {
  const { ts, level, component, event, ...rest } = record as Record<string, string>;
  const suffix = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${ts} ${String(level).toUpperCase().padEnd(5)} [${component}] ${event}${suffix}`;
}

/**
 * Monotonic nanoseconds. Wall-clock time can jump (NTP, VM migration) and is
 * therefore unusable for measuring latency or staleness.
 */
export function nowMonoNs(): bigint {
  return process.hrtime.bigint();
}

/** Stable-ish host identifier for correlating logs across restarts. */
export function hostId(): string {
  return process.env['HOSTNAME'] ?? 'unknown-host';
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histogram = new Map<string, number[]>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record a duration sample, keeping a bounded window for a readable p95. */
  observe(name: string, ms: number): void {
    const samples = this.histogram.get(name) ?? [];
    samples.push(ms);
    // A bounded ring: unbounded growth here would be a slow memory leak.
    if (samples.length > 512) samples.shift();
    this.histogram.set(name, samples);
  }

  snapshot(): Record<string, unknown> {
    const histograms: Record<string, { p50: number; p95: number; count: number }> = {};
    for (const [name, samples] of this.histogram) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      histograms[name] = {
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
        count: sorted.length,
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }
}

/**
 * Decision funnel: where each evaluated opportunity ended up, and why.
 * A healthy observe-only engine shows a large `NO_EDGE_AFTER_FEES` count — that
 * is the engine working, not failing.
 */
export class Funnel {
  private readonly stages = new Map<string, number>();
  private readonly reasons = new Map<string, number>();

  markStage(stage: string): void {
    this.stages.set(stage, (this.stages.get(stage) ?? 0) + 1);
  }

  markReason(reason: string): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  snapshot(): { stages: Record<string, number>; reasons: Record<string, number> } {
    return {
      stages: Object.fromEntries(this.stages),
      reasons: Object.fromEntries(this.reasons),
    };
  }
}
