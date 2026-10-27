/**
 * packages/obs — structured logging, metrics, funnel telemetry, redaction.
 *
 * One JSON object per line so logs are machine-traced end to end. Every record
 * carries: ts (UTC), level, component, event, plus optional intentId/routeKey,
 * so a single attempt can be reconstructed from logs alone.
 *
 * Secret safety: values pass through `redact()` before serialisation, so a
 * keypair, bearer token or RPC credential cannot leak even if a caller logs a
 * whole config object by mistake.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN = /(secret|private|keypair|mnemonic|passphrase|api[-_]?key|password|authorization)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, // base58 secret key blob
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\bhttps?:\/\/[^\s:@/]+:[^\s@/]+@/gi, // user:pass@host
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return redact({ name: value.name, message: value.message }, depth + 1);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === 'string' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly component: string;
  readonly level?: LogLevel;
  readonly pretty?: boolean;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const pretty = options.pretty ?? false;
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  const emit = (
    logLevel: LogLevel,
    component: string,
    bindings: LogFields,
    event: string,
    fields?: LogFields,
  ): void => {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const record = {
      ts: now().toISOString(),
      level: logLevel,
      component,
      event,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(pretty ? `${record.ts} ${logLevel.toUpperCase().padEnd(5)} ${component} ${event} ${JSON.stringify(record)}` : JSON.stringify(record));
  };

  const make = (component: string, bindings: LogFields): Logger => ({
    debug: (event, fields) => emit('debug', component, bindings, event, fields),
    info: (event, fields) => emit('info', component, bindings, event, fields),
    warn: (event, fields) => emit('warn', component, bindings, event, fields),
    error: (event, fields) => emit('error', component, bindings, event, fields),
    child: (extra) => make(component, { ...bindings, ...extra }),
  });

  return make(options.component, {});
}

/* ------------------------------------------------------------------ metrics */

export interface HistogramSnapshot {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Bounded ring-buffer histogram in milliseconds. Hot-path safe, no growth. */
export class LatencyHistogram {
  private readonly samples: Float64Array;
  private cursor = 0;
  private size = 0;

  constructor(capacity = 512) {
    this.samples = new Float64Array(capacity);
  }

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.samples.length;
    if (this.size < this.samples.length) this.size += 1;
  }

  snapshot(): HistogramSnapshot {
    if (this.size === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const values = Array.from(this.samples.slice(0, this.size)).sort((a, b) => a - b);
    const pick = (p: number): number =>
      values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))] as number;
    return {
      count: values.length,
      p50: Number(pick(0.5).toFixed(2)),
      p95: Number(pick(0.95).toFixed(2)),
      p99: Number(pick(0.99).toFixed(2)),
      max: Number((values[values.length - 1] as number).toFixed(2)),
    };
  }
}

/**
 * Pipeline funnel (V6 §10). Every stage is counted and every rejection is
 * attributed to a reason code, so "zero trades" is explainable, never silent.
 */
export class Funnel {
  private readonly stages = new Map<string, number>();
  private readonly reasons = new Map<string, number>();

  markStage(stage: string, delta = 1): void {
    this.stages.set(stage, (this.stages.get(stage) ?? 0) + delta);
  }

  markReason(reason: string, delta = 1): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + delta);
  }

  snapshot(): { stages: Record<string, number>; reasons: Record<string, number> } {
    return {
      stages: Object.fromEntries([...this.stages.entries()].sort()),
      reasons: Object.fromEntries([...this.reasons.entries()].sort()),
    };
  }
}

export interface RpcObservation {
  readonly providerId: string;
  readonly method: string;
  readonly hostId: string;
  readonly startedMonoNs: bigint;
  readonly finishedMonoNs: bigint;
  readonly status: 'OK' | 'ERROR' | 'TIMEOUT' | 'RATE_LIMITED';
}

/**
 * RTT uses `process.hrtime.bigint()` (monotonic) — never wall-clock
 * subtraction, which corrupts under NTP correction (V6 legacy L-07).
 */
export function nowMonoNs(): bigint {
  return process.hrtime.bigint();
}

export function roundTripMs(observation: RpcObservation): number {
  const delta = observation.finishedMonoNs - observation.startedMonoNs;
  if (delta < 0n) return -1;
  return Number(delta) / 1_000_000;
}

export function hostId(): string {
  return process.env.HOSTNAME || `pid-${process.pid}`;
}

export * from './metrics';
