/**
 * apps/solana-worker/health — loopback health and control surface.
 *
 * Two distinct signals, because they fail differently:
 *   - liveness  (is the process alive)
 *   - readiness (is the FEED coherent, and is the engine permitted to trade)
 *
 * A process can be perfectly alive while its feed is stale; conflating the two
 * is what lets a dead subscription look healthy from the outside.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { Funnel, Logger, Metrics } from '../../../packages/obs/src';
import type { MarketStateStore } from '../../../packages/market/src';
import type { ReservationLedger } from '../../../packages/policy/src';
import type { SignedOutbox } from '../../../packages/journal/src';

export interface HealthDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly funnel: Funnel;
  readonly market: MarketStateStore;
  readonly ledger: ReservationLedger;
  readonly journal: SignedOutbox;
  readonly pauseFile: string;
  readonly getStreamStatus: () => string;
  readonly getProviderStates: () => Array<Record<string, unknown>>;
  readonly getUnresolvedIntents: () => number;
}

export interface PauseState {
  paused: boolean;
  source: string;
}

/** Pause is fail-safe: a readable pause file pauses; only its absence resumes. */
export function readPauseState(pauseFile: string, emergencyPause: boolean): PauseState {
  if (emergencyPause) return { paused: true, source: 'EMERGENCY_PAUSE_ENV' };
  if (pauseFile !== '' && existsSync(pauseFile)) return { paused: true, source: 'PAUSE_FILE' };
  return { paused: false, source: 'NONE' };
}

export function startHealthServer(deps: HealthDeps, port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/healthz' || url === '/readyz') {
      const pools = deps.market.snapshot();
      const feedHealthy = pools.length > 0 && pools.every((p) => Number(p.ageMs ?? 1e9) < 10_000);
      const body = {
        status: feedHealthy ? 'ok' : 'degraded',
        stream: deps.getStreamStatus(),
        feedHealthy,
        unresolvedIntents: deps.getUnresolvedIntents(),
        feeBudget: {
          spentRaw: deps.ledger.spentRaw.toString(),
          // null = no budget granted yet (observe-only mode).
          capRaw: deps.ledger.capRaw === null ? null : deps.ledger.capRaw.toString(),
          isBudgeted: deps.ledger.isBudgeted,
          outstandingRaw: deps.ledger.outstandingRaw().toString(),
          periodStartUtc: deps.ledger.periodStart,
        },
        pools,
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
          unresolved: deps.journal.unresolved(),
        }),
      );
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
