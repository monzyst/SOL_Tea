/**
 * packages/control — independent pause transport, alerting, and outbox delivery.
 *
 * Why "independent". The reviewed designs paused on a local file plus an env var.
 * Both live on the same host as the engine: if the host is wedged, out of disk, or
 * simply not reachable by whoever is trying to stop it, neither channel works.
 * The moment you most need the stop is the moment a local control is least
 * reliable.
 *
 * Three channels, ORed, with an explicit failure policy:
 *   1. local file      — fast, works offline;
 *   2. env var         — works when the filesystem is read-only;
 *   3. remote document — works when the HOST is gone (an operator flips a flag in
 *                        a bucket/gist/status page and the engine picks it up).
 *
 * Failure policy for the remote channel is FAIL-CLOSED but STICKY:
 *  - a successful read of `{"paused": true}` pauses;
 *  - a read that ERRORS keeps the last known value for `staleAfterMs`, and if the
 *    value is older than that the engine treats itself as paused, because a
 *    monitor we cannot reach must never be able to silently un-pause trading.
 *
 * Alerting goes through a durable outbox: alerts are written to the DB first and
 * delivered second, so a webhook outage does not lose the notification that
 * something went wrong. Delivery is best-effort with bounded attempts — an alert
 * that cannot be delivered must never block the trading loop.
 */

import { existsSync } from 'node:fs';
import type { Logger } from '../../obs/src';
import type { Store } from '../../store/src';

export type PauseSource = 'file' | 'env' | 'remote' | 'none';

export interface PauseState {
  readonly paused: boolean;
  readonly sources: readonly PauseSource[];
  readonly detail: Record<string, unknown>;
  /** True when the remote channel is unreachable beyond its staleness bound. */
  readonly remoteStale: boolean;
}

export interface RemotePauseOptions {
  /** Endpoint returning JSON `{"paused": boolean}`. Empty disables the channel. */
  readonly url: string;
  readonly timeoutMs: number;
  /** How long a cached remote value stays trustworthy when reads fail. */
  readonly staleAfterMs: number;
  readonly fetcher?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  readonly now?: () => number;
}

/**
 * Remote pause channel with sticky fail-closed semantics.
 *
 * `refresh()` never throws: a monitoring outage must not crash the engine, but it
 * must not be mistaken for "healthy and unpaused" either.
 */
export class RemotePauseChannel {
  private lastKnownPaused: boolean | null = null;
  private lastSuccessMs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: RemotePauseOptions) {}

  get enabled(): boolean {
    return this.options.url !== '';
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  async refresh(): Promise<{ paused: boolean; stale: boolean; detail: Record<string, unknown> }> {
    if (!this.enabled) return { paused: false, stale: false, detail: { channel: 'disabled' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const fetcher = this.options.fetcher ?? ((url, init) => fetch(url, init));
      const response = await fetcher(this.options.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { paused?: unknown };
      if (typeof body.paused !== 'boolean') {
        throw new Error('remote pause document must contain a boolean `paused` field');
      }
      this.lastKnownPaused = body.paused;
      this.lastSuccessMs = this.now();
      this.lastError = null;
      return {
        paused: body.paused,
        stale: false,
        detail: { channel: 'remote', paused: body.paused },
      };
    } catch (error) {
      this.lastError = (error as Error).message;
      const age = this.lastSuccessMs === null ? Number.POSITIVE_INFINITY : this.now() - this.lastSuccessMs;
      const stale = age > this.options.staleAfterMs;
      // Stale monitor => assume paused. Losing the ability to observe the stop
      // switch is not permission to keep trading.
      const paused = stale ? true : (this.lastKnownPaused ?? false);
      return {
        paused,
        stale,
        detail: {
          channel: 'remote',
          error: this.lastError,
          cacheAgeMs: Number.isFinite(age) ? age : null,
          assumedPaused: stale,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PauseCompositeInput {
  readonly pauseFilePath: string;
  readonly envPaused: boolean;
  readonly remote: RemotePauseChannel;
}

/** Combine all channels. Any channel may pause; only all-clear un-pauses. */
export async function readPauseState(input: PauseCompositeInput): Promise<PauseState> {
  const sources: PauseSource[] = [];
  const detail: Record<string, unknown> = {};

  if (input.pauseFilePath !== '' && existsSync(input.pauseFilePath)) {
    sources.push('file');
    detail['file'] = input.pauseFilePath;
  }
  if (input.envPaused) {
    sources.push('env');
    detail['env'] = 'EMERGENCY_PAUSE';
  }

  let remoteStale = false;
  if (input.remote.enabled) {
    const remote = await input.remote.refresh();
    if (remote.paused) sources.push('remote');
    remoteStale = remote.stale;
    detail['remote'] = remote.detail;
  }

  return {
    paused: sources.length > 0,
    sources,
    detail,
    remoteStale,
  };
}

/** Synchronous, file+env-only check. Used on the hot path between refreshes. */
export function readPauseStateFast(input: {
  pauseFilePath: string;
  envPaused: boolean;
  cachedRemotePaused: boolean;
}): { paused: boolean; sources: PauseSource[] } {
  const sources: PauseSource[] = [];
  if (input.pauseFilePath !== '' && existsSync(input.pauseFilePath)) sources.push('file');
  if (input.envPaused) sources.push('env');
  if (input.cachedRemotePaused) sources.push('remote');
  return { paused: sources.length > 0, sources };
}

/* ------------------------------------------------------------------ alerting */

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert {
  readonly topic: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

export interface AlertTransport {
  deliver(alert: Alert): Promise<void>;
}

export interface WebhookAlertTransportOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Minimal webhook transport. The payload shape is deliberately plain JSON. */
export class WebhookAlertTransport implements AlertTransport {
  constructor(private readonly options: WebhookAlertTransportOptions) {}

  async deliver(alert: Alert): Promise<void> {
    const fetcher = this.options.fetcher ?? ((url, init) => fetch(url, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3_000);
    try {
      const response = await fetcher(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          service: 'sol-tea',
          severity: alert.severity,
          topic: alert.topic,
          message: alert.message,
          fields: alert.fields ?? {},
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`webhook responded ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Durable alerting: enqueue in the store, then attempt delivery.
 *
 * Writing first is the whole point — a trading engine that discovers a critical
 * fault while its webhook is down should still have a record of the fault when the
 * webhook comes back. Delivery failure is logged and retried on the next sweep.
 */
export class AlertDispatcher {
  constructor(
    private readonly deps: {
      store: Store;
      transport: AlertTransport | null;
      logger: Logger;
      nowUtc?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.nowUtc ? this.deps.nowUtc() : new Date();
  }

  /** Record then attempt delivery. Never throws. */
  async notify(alert: Alert): Promise<void> {
    // The enqueue itself can fail (disk full); that must not propagate into the
    // trading loop either, so it is caught and logged as loudly as possible.
    let outboxId: string;
    try {
      outboxId = this.deps.store.enqueue({
        topic: alert.topic,
        payload: {
          severity: alert.severity,
          message: alert.message,
          fields: alert.fields ?? {},
        },
        nowUtc: this.now(),
      });
    } catch (error) {
      this.deps.logger.error('alert_enqueue_failed', {
        topic: alert.topic,
        error: (error as Error).message,
      });
      return;
    }

    if (!this.deps.transport) {
      this.deps.logger.debug('alert_no_transport', { topic: alert.topic, outboxId });
      return;
    }
    try {
      await this.deps.transport.deliver(alert);
      this.deps.store.markDelivered(outboxId, this.now());
    } catch (error) {
      this.deps.logger.warn('alert_delivery_failed', {
        topic: alert.topic,
        outboxId,
        error: (error as Error).message,
      });
      this.deps.store.markDelivered(outboxId, this.now(), (error as Error).message);
    }
  }

  /** Retry previously undelivered alerts, bounded per sweep. */
  async drainPending(limit = 20): Promise<{ attempted: number; delivered: number }> {
    if (!this.deps.transport) return { attempted: 0, delivered: 0 };
    const pending = this.deps.store.pendingOutbox(limit);
    let delivered = 0;
    let attempted = 0;

    for (const item of pending) {
      attempted += 1;
      try {
        await this.deps.transport.deliver({
          topic: item.topic,
          severity: (item.payload['severity'] as AlertSeverity) ?? 'warn',
          message: String(item.payload['message'] ?? ''),
          fields: (item.payload['fields'] as Record<string, unknown>) ?? {},
        });
        this.deps.store.markDelivered(item.outboxId, this.now());
        delivered += 1;
      } catch (error) {
        this.deps.store.markDelivered(item.outboxId, this.now(), (error as Error).message);
      }
    }
    return { attempted, delivered };
  }
}
