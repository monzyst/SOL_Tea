/**
 * packages/rpc — provider pool with measured health and honest failover.
 *
 * Design notes (V6 §10/§12):
 *  - A provider is only marked unhealthy after *consecutive* failures, so one
 *    timeout does not flap the whole engine.
 *  - Every call is measured with a monotonic clock and recorded as an
 *    observation (provider, method, RTT, status) for the quality report.
 *  - Failover is bounded: each provider is tried at most once per read. Writes
 *    are never retried here — the executor owns idempotency by signature.
 */

import { Connection } from '@solana/web3.js';
import { LatencyHistogram, nowMonoNs, type Logger } from '../../obs/src';

export type ProviderRole = 'primary' | 'secondary';

export interface ProviderConfig {
  readonly id: string;
  readonly role: ProviderRole;
  readonly httpUrl: string;
  readonly wsUrl: string;
}

export interface ProviderState {
  readonly config: ProviderConfig;
  readonly connection: Connection;
  healthy: boolean;
  consecutiveFailures: number;
  lastSuccessUtc: string | null;
  lastErrorUtc: string | null;
  readonly latency: LatencyHistogram;
}

export interface ProviderPoolOptions {
  readonly commitment: 'confirmed' | 'finalized';
  readonly logger: Logger;
  /** Consecutive failures before a provider leaves rotation. */
  readonly failureThreshold?: number;
}

export class AllProvidersFailedError extends Error {
  constructor(
    readonly method: string,
    readonly causes: readonly string[],
  ) {
    super(`all RPC providers failed for ${method}: ${causes.join(' | ')}`);
    this.name = 'AllProvidersFailedError';
  }
}

export class ProviderPool {
  private readonly states: ProviderState[];
  private readonly failureThreshold: number;

  constructor(
    configs: readonly ProviderConfig[],
    private readonly options: ProviderPoolOptions,
  ) {
    if (configs.length === 0) throw new Error('ProviderPool requires at least one provider');
    if (new Set(configs.map((c) => c.id)).size !== configs.length) {
      throw new Error('provider ids must be unique');
    }
    this.failureThreshold = options.failureThreshold ?? 2;
    this.states = configs.map((config) => ({
      config,
      connection: new Connection(config.httpUrl, {
        commitment: options.commitment,
        disableRetryOnRateLimit: false,
        confirmTransactionInitialTimeout: 30_000,
      }),
      healthy: true,
      consecutiveFailures: 0,
      lastSuccessUtc: null,
      lastErrorUtc: null,
      latency: new LatencyHistogram(256),
    }));
  }

  get primary(): ProviderState {
    return this.states[0] as ProviderState;
  }

  /** Healthy providers first, then degraded ones — never an empty list. */
  rotation(): ProviderState[] {
    return [...this.states.filter((s) => s.healthy), ...this.states.filter((s) => !s.healthy)];
  }

  statesSnapshot(): Array<Record<string, unknown>> {
    return this.states.map((s) => ({
      id: s.config.id,
      role: s.config.role,
      healthy: s.healthy,
      consecutiveFailures: s.consecutiveFailures,
      lastSuccessUtc: s.lastSuccessUtc,
      lastErrorUtc: s.lastErrorUtc,
      latencyMs: s.latency.snapshot(),
    }));
  }

  /**
   * Execute an idempotent READ against the first provider that answers.
   * Reads are safe to re-issue; transaction submission never routes here.
   */
  async read<T>(method: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const causes: string[] = [];
    for (const state of this.rotation()) {
      const started = nowMonoNs();
      try {
        const result = await fn(state.connection);
        this.onSuccess(state, started, method);
        return result;
      } catch (error) {
        this.onFailure(state, started, method, error);
        causes.push(`${state.config.id}: ${(error as Error).message}`);
      }
    }
    throw new AllProvidersFailedError(method, causes);
  }

  private onSuccess(state: ProviderState, started: bigint, method: string): void {
    const ms = Number(nowMonoNs() - started) / 1_000_000;
    state.latency.observe(ms);
    const recovered = !state.healthy;
    state.consecutiveFailures = 0;
    state.healthy = true;
    state.lastSuccessUtc = new Date().toISOString();
    if (recovered) {
      this.options.logger.info('rpc_provider_recovered', { providerId: state.config.id, method });
    }
    this.options.logger.debug('rpc_call_ok', {
      providerId: state.config.id,
      method,
      latencyMs: Number(ms.toFixed(2)),
    });
  }

  private onFailure(state: ProviderState, started: bigint, method: string, error: unknown): void {
    const ms = Number(nowMonoNs() - started) / 1_000_000;
    state.latency.observe(ms);
    state.consecutiveFailures += 1;
    state.lastErrorUtc = new Date().toISOString();
    const wasHealthy = state.healthy;
    if (state.consecutiveFailures >= this.failureThreshold) state.healthy = false;
    this.options.logger.warn('rpc_call_failed', {
      providerId: state.config.id,
      method,
      latencyMs: Number(ms.toFixed(2)),
      consecutiveFailures: state.consecutiveFailures,
      transitionedToDegraded: wasHealthy && !state.healthy,
      error: (error as Error).message,
    });
  }
}

/**
 * A connection factory that FAILS OVER across providers on each attempt.
 *
 * Audit T07: the subscription layer was pinned to a single `RPC_WS_URL`, so the
 * HTTP failover in ProviderPool was cosmetic — a dead websocket host meant a dead
 * engine while HTTP reads kept succeeding and looked healthy. This factory walks
 * the same rotation, so a reconnect advances to the next provider instead of
 * retrying a host that is known to be down.
 *
 * The cursor advances once per connection attempt (not per healthy period), so a
 * long-lived stream is never migrated mid-flight, which would lose slots.
 */
export class FailoverConnectionFactory {
  private cursor = 0;

  constructor(
    private readonly pool: ProviderPool,
    private readonly commitment: 'confirmed' | 'finalized',
    private readonly logger: Logger,
  ) {}

  /** Provider id that the NEXT connection attempt will use. */
  peekProviderId(): string {
    const rotation = this.pool.rotation();
    return (rotation[this.cursor % rotation.length] as ProviderState).config.id;
  }

  /** Build a Connection against the next provider in rotation. */
  next(): { connection: Connection; wsUrl: string; providerId: string } {
    const rotation = this.pool.rotation();
    const state = rotation[this.cursor % rotation.length] as ProviderState;
    this.cursor = (this.cursor + 1) % rotation.length;
    this.logger.info('ws_provider_selected', {
      providerId: state.config.id,
      healthy: state.healthy,
      rotationSize: rotation.length,
    });
    return {
      connection: new Connection(state.config.httpUrl, {
        commitment: this.commitment,
        wsEndpoint: state.config.wsUrl,
      }),
      wsUrl: state.config.wsUrl,
      providerId: state.config.id,
    };
  }

  /** Reset to the head of rotation (e.g. after a full health recovery). */
  reset(): void {
    this.cursor = 0;
  }
}

export function buildProviderConfigs(input: {
  httpUrl: string;
  wsUrl: string;
  httpUrlSecondary?: string | undefined;
  wsUrlSecondary?: string | undefined;
}): ProviderConfig[] {
  const out: ProviderConfig[] = [
    { id: 'primary', role: 'primary', httpUrl: input.httpUrl, wsUrl: input.wsUrl },
  ];
  if (input.httpUrlSecondary && input.wsUrlSecondary) {
    out.push({
      id: 'secondary',
      role: 'secondary',
      httpUrl: input.httpUrlSecondary,
      wsUrl: input.wsUrlSecondary,
    });
  }
  return out;
}
