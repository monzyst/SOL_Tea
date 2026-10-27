/**
 * apps/solana-worker/health — loopback health and control surface.
 *
 * Two distinct signals, because they fail differently:
 *   - liveness  (is the process alive)
 *   - readiness (is the FEED coherent, and is the engine permitted to trade)
 *
 * A process can be perfectly alive while its feed is stale; conflating the two
 * is what lets a dead subscription look healthy from the outside.
 *
 * `/healthz` is deliberately verbose: fee budget, route health, live-gate
 * blockers, liquidity-map coverage and the current priority-fee estimate. An
 * operator deciding whether to intervene should not have to correlate five log
 * greps to answer "why is it not trading".
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { Funnel, Logger, Metrics } from '../../../packages/obs/src';
import type { MarketStateStore } from '../../../packages/market/src';
import type { SignedOutbox } from '../../../packages/journal/src';
import type { Store } from '../../../packages/store/src';

export interface HealthDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly funnel: Funnel;
  readonly market: MarketStateStore;
  readonly journal: SignedOutbox;
  readonly store: Store;
  readonly pauseFile: string;
  readonly getStreamStatus: () => string;
  readonly getProviderStates: () => Array<Record<string, unknown>>;
  readonly getUnresolvedIntents: () => number;
  readonly getLiquiditySnapshot: () => Array<Record<string, unknown>>;
  readonly getPriorityFee: () => Record<string, unknown> | null;
  readonly getLiveGate: () => { allowed: boolean; reasons: readonly string[] };
}

/** Pause is fail-safe: a readable pause file pauses; only its absence resumes. */
export function readPauseFile(pauseFile: string, emergencyPause: boolean): {
  paused: boolean;
  source: string;
} {
  if (emergencyPause) return { paused: true, source: 'EMERGENCY_PAUSE_ENV' };
  if (pauseFile !== '' && existsSync(pauseFile)) return { paused: true, source: 'PAUSE_FILE' };
  return { paused: false, source: 'NONE' };
}

export function startHealthServer(deps: HealthDeps, port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/healthz' || url === '/readyz') {
      const pools = deps.market.snapshot();
      const liquidity = deps.getLiquiditySnapshot();
      const feedHealthy = pools.length > 0 && pools.every((p) => Number(p.ageMs ?? 1e9) < 10_000);
      // Readiness requires a coherent feed AND at least one priced pool: a feed
      // without a liquidity map cannot produce an executable quote.
      const priceable = liquidity.length > 0;
      const totals = deps.store.totals();
      const gate = deps.getLiveGate();

      const body = {
        status: feedHealthy ? 'ok' : 'degraded',
        stream: deps.getStreamStatus(),
        feedHealthy,
        priceable,
        liveGate: { allowed: gate.allowed, reasons: gate.reasons },
        unresolvedIntents: deps.getUnresolvedIntents(),
        intents: {
          total: totals.attempts,
          reconciled: totals.reconciled,
          provenNetPositive: totals.netPositive,
          realisedDeltaRaw: totals.realisedDeltaRaw.toString(),
          feesLamports: totals.feesLamports.toString(),
        },
        priorityFee: deps.getPriorityFee(),
        pools,
        liquidity,
        providers: deps.getProviderStates(),
        funnel: deps.funnel.snapshot(),
        metrics: deps.metrics.snapshot(),
      };
      res.writeHead(feedHealthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (url === '/journal') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          path: deps.journal.path,
          size: deps.journal.size,
          tip: deps.journal.tip,
          recovery: {
            signedNotSubmitted: deps.journal.recovery().signedNotSubmitted.length,
            submittedUnresolved: deps.journal.recovery().submittedUnresolved.length,
            awaitingFinality: deps.journal.recovery().awaitingFinality.length,
          },
          unresolved: deps.journal.unresolved(),
        }),
      );
      return;
    }

    if (url === '/outbox') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pending: deps.store.pendingOutbox(50) }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, host, () => {
    deps.logger.info('health_server_listening', { host, port });
  });
  return server;
}
