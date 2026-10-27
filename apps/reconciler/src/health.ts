/**
 * apps/reconciler/health — minimal health surface for the settlement role.
 *
 * Deliberately NOT the worker's surface: the reconciler has no feed, no liquidity
 * map and no live gate. Reporting those fields here would be fabricated data, so
 * this endpoint reports only what this process actually knows — how many attempts
 * are unresolved, what the books say, and whether its round loop is advancing.
 *
 * A stuck loop is the dangerous failure for this role (attempts silently stop
 * being settled), so `lastRoundAt` and `stalled` are first-class.
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from '../../../packages/obs/src';

/** A round that has not advanced in this long means the loop is wedged. */
const STALL_AFTER_MS = 60_000;

export interface ReconcilerHealthDeps {
  readonly logger: Logger;
  readonly port: number;
  readonly snapshot: () => Record<string, unknown>;
}

export class ReconcilerHealth {
  private readonly server: Server;
  private lastRoundAt = Date.now();

  constructor(private readonly deps: ReconcilerHealthDeps, host = '127.0.0.1') {
    this.server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url !== '/healthz' && url !== '/readyz') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const sinceRoundMs = Date.now() - this.lastRoundAt;
      const stalled = sinceRoundMs > STALL_AFTER_MS;
      const body = {
        service: 'reconciler',
        // Never "ok" while the loop is stuck: an idle reconciler looks identical
        // to a healthy one unless we say otherwise.
        status: stalled ? 'degraded' : 'ok',
        stalled,
        sinceLastRoundMs: sinceRoundMs,
        ...this.deps.snapshot(),
      };
      res.writeHead(stalled ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    this.server.listen(this.deps.port, host, () => {
      this.deps.logger.info('health_server_listening', { host, port: this.deps.port });
    });
  }

  /** Called once per completed round. */
  tick(): void {
    this.lastRoundAt = Date.now();
  }

  close(): void {
    this.server.close();
  }
}

export function startHealthServer(deps: ReconcilerHealthDeps): ReconcilerHealth {
  return new ReconcilerHealth(deps);
}
