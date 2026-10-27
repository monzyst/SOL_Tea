/**
 * packages/rpc/ws-manager — real-time subscription layer.
 *
 * Responsibilities (V6 §10):
 *  1. Hold the program-account subscription for the pools we actually trade,
 *     plus a slot subscription used as a liveness heartbeat.
 *  2. Detect *gaps*: a slot jump beyond `maxSlotGap`, or a stream that goes
 *     silent longer than `stallThresholdMs`, means cached pool state must be
 *     treated as incoherent until a full resync completes.
 *  3. Reconnect automatically with exponential backoff + jitter, resubscribing
 *     on every attempt, and report every transition so flapping is visible.
 *
 * The manager never parses pool math — it emits raw account bytes plus the
 * timing metadata the market layer needs to judge coherence.
 */

import { PublicKey, type Connection, type AccountInfo } from '@solana/web3.js';
import { nowMonoNs, type Logger } from '../../obs/src';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'degraded' | 'stopped';

export interface PoolUpdate {
  readonly poolAddress: string;
  readonly data: Buffer;
  readonly slot: number;
  readonly receivedAtUtc: string;
  readonly receivedMonoNs: bigint;
  readonly providerId: string;
}

export interface StreamGap {
  readonly reason: 'SLOT_GAP' | 'STALL' | 'RESUBSCRIBE';
  readonly detail: Record<string, unknown>;
  readonly atUtc: string;
}

export interface SubscriptionManagerOptions {
  readonly wsUrl: string;
  readonly programId: string;
  readonly poolAddresses: readonly string[];
  readonly commitment: 'confirmed' | 'finalized';
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly stallThresholdMs: number;
  readonly healthCheckIntervalMs: number;
  /** A slot jump larger than this invalidates cached state. */
  readonly maxSlotGap: number;
  readonly logger: Logger;
  /**
   * Provider whose stream this manager is attached to. Reported in every
   * update so the market layer can attribute a gap to the right backend
   * (audit T07).
   */
  readonly providerId: string;
  readonly onPoolUpdate: (update: PoolUpdate) => void;
  /** Called on every slot heartbeat with the current chain tip. */
  readonly onSlot?: (slot: number) => void;
  readonly onGap: (gap: StreamGap) => void;
  readonly onStatus: (status: StreamStatus, detail?: Record<string, unknown>) => void;
  /**
   * Connection factory kept injectable so the manager is unit-testable. The
   * `wsUrl` argument is a hint only: a failover factory ignores it and picks
   * the next healthy provider, which is the behaviour we want in production
   * (see FailoverConnectionFactory).
   */
  readonly connect: (wsUrl: string, commitment: 'confirmed' | 'finalized') => Connection;
  /**
   * Optional hook reporting which provider a (re)connect actually used. When
   * present, the manager adopts that id so `providerId` on each update is the
   * truth, not the configuration default.
   */
  readonly resolveProviderId?: () => string;
}

export class SubscriptionManager {
  private connection: Connection | null = null;
  private accountSubscriptionId: number | null = null;
  private slotSubscriptionId: number | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private lastSlot = 0;
  private lastEventMonoNs = 0n;
  private status: StreamStatus = 'idle';
  private stopped = false;
  private readonly poolKeys: PublicKey[];
  /** Provider currently serving this stream; refreshed on every reconnect. */
  private activeProviderId: string;

  constructor(private readonly options: SubscriptionManagerOptions) {
    this.poolKeys = options.poolAddresses.map((address) => new PublicKey(address));
    if (this.poolKeys.length === 0) throw new Error('at least one pool address is required');
    if (options.maxSlotGap <= 0) throw new Error('maxSlotGap must be positive');
    this.activeProviderId = options.providerId;
  }

  getStatus(): StreamStatus {
    return this.status;
  }

  getLastSlot(): number {
    return this.lastSlot;
  }

  /** Provider currently feeding this stream (changes only on reconnect). */
  getProviderId(): string {
    return this.activeProviderId;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.connectAndSubscribe();
    this.healthTimer = setInterval(() => this.checkHealth(), this.options.healthCheckIntervalMs);
    // Never keep the process alive purely for the health timer.
    this.healthTimer.unref?.();
  }

  /** Full teardown; idempotent and safe to call from a signal handler. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.healthTimer = null;
    this.reconnectTimer = null;
    await this.teardownSubscriptions();
    this.setStatus('stopped');
  }

  private setStatus(status: StreamStatus, detail?: Record<string, unknown>): void {
    if (this.status === status) return;
    this.status = status;
    this.options.logger.info('ws_status', {
      status,
      providerId: this.activeProviderId,
      ...detail,
    });
    this.options.onStatus(status, detail);
  }

  private async connectAndSubscribe(): Promise<void> {
    if (this.stopped) return;
    this.setStatus('connecting', { attempt: this.attempt });
    try {
      this.connection = this.options.connect(this.options.wsUrl, this.options.commitment);
      // Adopt the provider the factory actually chose, so every update carries
      // the true source and a gap can be attributed correctly.
      if (this.options.resolveProviderId) {
        const resolved = this.options.resolveProviderId();
        if (resolved !== this.activeProviderId) {
          this.options.logger.info('ws_provider_changed', {
            from: this.activeProviderId,
            to: resolved,
          });
          this.activeProviderId = resolved;
        }
      }
      this.lastEventMonoNs = nowMonoNs();

      // Slot heartbeat: cheap liveness signal for the whole stream.
      this.slotSubscriptionId = this.connection.onSlotChange((slotInfo) => {
        const slot = slotInfo.slot;
        if (this.lastSlot > 0 && slot - this.lastSlot > this.options.maxSlotGap) {
          this.options.onGap({
            reason: 'SLOT_GAP',
            detail: { previousSlot: this.lastSlot, currentSlot: slot, gap: slot - this.lastSlot },
            atUtc: new Date().toISOString(),
          });
        }
        this.lastSlot = slot;
        this.lastEventMonoNs = nowMonoNs();
        // Expose the tip to the consumer. Treat this callback as HOT PATH: it
        // fires every slot (~400ms) and must never block or throw.
        try {
          this.options.onSlot?.(slot);
        } catch {
          // A consumer bug must not tear down the stream; the health timer will
          // surface a dead feed independently.
        }
      });

      // Pool account subscription.
      //
      // NOTE: no `memcmp` filter here. `onProgramAccountChange` memcmp filters
      // match against ACCOUNT DATA, not the account key, so an offset-0 filter on
      // a pool address can never match. The program filter is the only
      // server-side narrowing available, and `handleAccountUpdate` drops every
      // account that is not one of our registered pools.
      this.accountSubscriptionId = this.connection.onProgramAccountChange(
        new PublicKey(this.options.programId),
        (keyedAccount, context) => {
          this.handleAccountUpdate(keyedAccount.accountId, keyedAccount.accountInfo, context.slot);
        },
        this.options.commitment,
      );

      this.attempt = 0;
      this.setStatus('live', { subscribedPools: this.poolKeys.length });
    } catch (error) {
      this.options.logger.error('ws_connect_failed', {
        providerId: this.activeProviderId,
        attempt: this.attempt,
        error: (error as Error).message,
      });
      this.scheduleReconnect('CONNECT_FAILED');
    }
  }

  private handleAccountUpdate(address: PublicKey, info: AccountInfo<Buffer>, slot: number): void {
    // The server-side filter should be exact; this guard makes it provable.
    if (!this.poolKeys.some((key) => key.equals(address))) return;

    this.lastEventMonoNs = nowMonoNs();
    this.options.onPoolUpdate({
      poolAddress: address.toBase58(),
      data: info.data,
      slot,
      receivedAtUtc: new Date().toISOString(),
      receivedMonoNs: this.lastEventMonoNs,
      providerId: this.activeProviderId,
    });
  }

  /**
   * Watchdog: a live subscription that stops producing account updates is
   * indistinguishable from a quiet market until we check the clock. This is the
   * difference between "no opportunity" and "no data" (V6 §10.1 FEED_STALE).
   */
  private checkHealth(): void {
    if (this.stopped || this.status !== 'live') return;
    const silenceMs = Number(nowMonoNs() - this.lastEventMonoNs) / 1_000_000;
    if (silenceMs > this.options.stallThresholdMs) {
      this.options.logger.warn('ws_stream_stalled', {
        providerId: this.activeProviderId,
        silenceMs: Math.round(silenceMs),
      });
      this.setStatus('degraded', { silenceMs: Math.round(silenceMs) });
      this.options.onGap({
        reason: 'STALL',
        detail: { silenceMs: Math.round(silenceMs) },
        atUtc: new Date().toISOString(),
      });
      this.scheduleReconnect('STALL');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const exponential = this.options.reconnectBaseMs * 2 ** Math.min(this.attempt, 6);
    const capped = Math.min(exponential, this.options.reconnectMaxMs);
    // Jitter prevents a fleet of workers stampeding the same provider.
    const delayMs = Math.round(capped * (0.75 + Math.random() * 0.5));
    this.options.logger.warn('ws_reconnect_scheduled', {
      providerId: this.activeProviderId,
      reason,
      attempt: this.attempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(reason);
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(reason: string): Promise<void> {
    await this.teardownSubscriptions();
    this.options.onGap({
      reason: 'RESUBSCRIBE',
      detail: { attempt: this.attempt },
      atUtc: new Date().toISOString(),
    });
    this.options.logger.info('ws_reconnecting', { providerId: this.activeProviderId, reason });
    await this.connectAndSubscribe();
  }

  private async teardownSubscriptions(): Promise<void> {
    const connection = this.connection;
    const accountId = this.accountSubscriptionId;
    const slotId = this.slotSubscriptionId;
    this.accountSubscriptionId = null;
    this.slotSubscriptionId = null;
    this.connection = null;
    if (!connection) return;
    try {
      // Failures are non-fatal: the underlying socket is discarded anyway.
      if (accountId !== null) await connection.removeProgramAccountChangeListener(accountId);
      if (slotId !== null) await connection.removeSlotChangeListener(slotId);
    } catch (error) {
      this.options.logger.debug('ws_unsubscribe_failed', { error: (error as Error).message });
    }
  }

  /** Force a resync after a gap, e.g. when a route is invalidated. */
  async resync(reason: string): Promise<void> {
    this.options.logger.info('ws_manual_resync', { providerId: this.activeProviderId, reason });
    await this.reconnect(reason);
  }
}
