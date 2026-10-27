/**
 * apps/solana-worker/pipeline — the real-time intake path, one hop at a time.
 *
 *   WS callback (raw bytes)
 *     -> decode (pure)                      [chains/solana/src/whirlpool]
 *     -> coherence gate                     [packages/market]
 *     -> discovery + ranking                [packages/strategies]
 *     -> admission + reservation            [packages/policy]
 *     -> executable quote (SDK)             [chains/solana/src/quoter]
 *     -> execute + journal + reconcile      [packages/executor, reconcile]
 *
 * Everything before the SDK quote is synchronous and allocation-light, so the
 * expensive work happens only for a candidate that already passed the gate.
 */

import type { Logger, Funnel, Metrics } from '../../../packages/obs/src';
import type { MarketStateStore } from '../../../packages/market/src';
import type { PoolBinding } from '../../../packages/registry/src';
import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import { decodeWhirlpool } from '../../../chains/solana/src/whirlpool';
import { discoverPair, bestCandidate, type CycleCandidate } from '../../../packages/strategies/src/arb';

export interface PipelineDeps {
  readonly logger: Logger;
  readonly funnel: Funnel;
  readonly metrics: Metrics;
  readonly market: MarketStateStore;
  readonly bindings: ReadonlyMap<string, PoolBinding>;
  readonly settlementMint: string;
  readonly nowUtc?: () => Date;
}

export interface DecodedUpdate {
  readonly snapshot: PoolSnapshot | null;
  readonly rejected: boolean;
  readonly reason: string | null;
}

/**
 * Decode one inbound account update. Never throws into the socket callback: a
 * malformed update is a *dropped* update with a logged reason, not a crash.
 */
export function ingestPoolUpdate(
  deps: PipelineDeps,
  update: {
    poolAddress: string;
    data: Buffer;
    owner: string;
    slot: number;
    receivedAtUtc: string;
    receivedMonoNs: bigint;
    providerId: string;
  },
): DecodedUpdate {
  const binding = deps.bindings.get(update.poolAddress);
  if (!binding) {
    deps.metrics.inc('pipeline.unknown_pool');
    return { snapshot: null, rejected: true, reason: 'UNKNOWN_POOL' };
  }

  try {
    const snapshot = decodeWhirlpool({
      binding,
      data: update.data,
      owner: update.owner,
      slot: update.slot,
      observedAtUtc: update.receivedAtUtc,
      observedMonoNs: update.receivedMonoNs,
      sourceProviderId: update.providerId,
    });
    const applied = deps.market.apply(snapshot);
    if (!applied.accepted) {
      deps.metrics.inc('pipeline.out_of_order_update');
      return { snapshot: null, rejected: true, reason: applied.reason ?? 'REJECTED' };
    }
    deps.metrics.inc('pipeline.pool_update');
    if (snapshot.coherence !== 'COHERENT') {
      deps.logger.warn('pool_degraded', {
        pool: snapshot.poolAddress,
        flags: snapshot.qualityFlags,
        slot: snapshot.slot,
      });
    }
    return { snapshot, rejected: false, reason: null };
  } catch (error) {
    deps.metrics.inc('pipeline.decode_error');
    deps.logger.error('pool_decode_failed', {
      pool: update.poolAddress,
      slot: update.slot,
      error: (error as Error).message,
    });
    // Treat an undecodable pool as untrusted until the next good update.
    deps.market.invalidate(update.poolAddress, 'DECODE_ERROR');
    return { snapshot: null, rejected: true, reason: (error as Error).message };
  }
}

/** Find the best cycle across every pair of registered pools. */
export function selectBestCycle(deps: PipelineDeps, amountInRaw: bigint): CycleCandidate | null {
  const pools = [...deps.bindings.keys()]
    .map((address) => deps.market.get(address))
    .filter((snapshot): snapshot is PoolSnapshot => snapshot !== undefined);

  if (pools.length < 2) {
    deps.funnel.markReason('FEED_STALE');
    return null;
  }

  const candidates: CycleCandidate[] = [];
  for (let i = 0; i < pools.length; i += 1) {
    for (let j = i + 1; j < pools.length; j += 1) {
      const a = pools[i] as PoolSnapshot;
      const b = pools[j] as PoolSnapshot;
      const readiness = deps.market.readiness(a.poolAddress, b.poolAddress);
      if (!readiness.ready) {
        deps.funnel.markReason(readiness.reason);
        continue;
      }
      candidates.push(
        ...discoverPair({
          settlementMint: deps.settlementMint,
          poolA: a,
          poolB: b,
          amountInRaw,
          nowUtc: deps.nowUtc ? deps.nowUtc() : new Date(),
        }),
      );
    }
  }

  if (candidates.length === 0) return null;
  deps.funnel.markStage('DISCOVERED');
  const best = bestCandidate(candidates);
  if (best) deps.funnel.markStage('RANKED');
  return best;
}
