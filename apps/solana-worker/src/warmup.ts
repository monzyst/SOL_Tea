/**
 * apps/solana-worker/warmup — seed live state before the first evaluation.
 *
 * Why this is not just an optimisation. Before the first websocket notification
 * arrives, the market store is empty, so `/healthz` reports an empty feed and the
 * evaluator has nothing to price. Two consequences matter:
 *
 *  - an operator cannot distinguish "just started" from "subscribed but silent",
 *    which is precisely the ambiguity FEED_STALE exists to remove;
 *  - the first opportunity after a restart is lost.
 *
 * So boot performs ONE batched read: every pool account in a single
 * `getMultipleAccountsInfoAndContext` call, decoded through the same
 * `decodeWhirlpool` used on the streaming path. Using the same decoder is the
 * point — a second, "warmup-only" decoder could disagree with the live one and
 * nobody would notice.
 *
 * Failure is non-fatal and explicit: a pool that cannot be warmed is simply not
 * present, and the first streaming update fills it in. Booting must not depend on
 * a single HTTP read succeeding.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import type { Logger } from '../../../packages/obs/src';
import type { MarketStateStore } from '../../../packages/market/src';
import type { PoolBinding } from '../../../packages/registry/src';
import { decodeWhirlpool, type PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import { readVaultReserves } from '../../../chains/solana/src/vaults';

export interface WarmupResult {
  readonly warmed: readonly string[];
  readonly failed: ReadonlyArray<{ pool: string; error: string }>;
  readonly slot: number | null;
}

/**
 * Read, decode and apply every registered pool.
 *
 * All pools come from ONE slot, so the seeded state is mutually consistent —
 * which is exactly the property the route gate checks.
 */
export async function warmupPools(input: {
  connection: Connection;
  market: MarketStateStore;
  bindings: ReadonlyMap<string, PoolBinding>;
  commitment: 'confirmed' | 'finalized';
  logger: Logger;
  nowUtc?: () => Date;
}): Promise<WarmupResult> {
  const addresses = [...input.bindings.keys()].map((address) => new PublicKey(address));
  if (addresses.length === 0) return { warmed: [], failed: [], slot: null };

  const warmed: string[] = [];
  const failed: Array<{ pool: string; error: string }> = [];

  let response;
  try {
    response = await input.connection.getMultipleAccountsInfoAndContext(addresses, input.commitment);
  } catch (error) {
    return {
      warmed: [],
      failed: addresses.map((address) => ({
        pool: address.toBase58(),
        error: (error as Error).message,
      })),
      slot: null,
    };
  }

  const observedAtUtc = (input.nowUtc ? input.nowUtc() : new Date()).toISOString();
  const observedMonoNs = process.hrtime.bigint();

  response.value.forEach((account, index) => {
    const address = addresses[index];
    if (!address) return;
    const poolAddress = address.toBase58();
    const binding = input.bindings.get(poolAddress);

    if (!binding) {
      failed.push({ pool: poolAddress, error: 'not a registered pool' });
      return;
    }
    if (!account) {
      failed.push({ pool: poolAddress, error: 'account not found' });
      return;
    }

    try {
      const snapshot: PoolSnapshot = decodeWhirlpool({
        binding,
        data: account.data,
        owner: account.owner.toBase58(),
        slot: response.context.slot,
        observedAtUtc,
        observedMonoNs,
        sourceProviderId: 'warmup-http',
      });
      const applied = input.market.apply(snapshot);
      if (!applied.accepted) {
        failed.push({ pool: poolAddress, error: applied.reason ?? 'rejected' });
        return;
      }
      warmed.push(poolAddress);
    } catch (error) {
      failed.push({ pool: poolAddress, error: (error as Error).message });
    }
  });

  // Reserves are a second read (vault token accounts). Done after the pool decode
  // so a vault failure does not lose the pool state itself.
  await Promise.all(
    warmed.map(async (poolAddress) => {
      const snapshot = input.market.get(poolAddress);
      if (!snapshot) return;
      try {
        const reserves = await readVaultReserves({
          connection: input.connection,
          poolAddress,
          vaultA: snapshot.vaultA,
          vaultB: snapshot.vaultB,
          commitment: input.commitment,
        });
        input.market.apply({ ...snapshot, reserveA: reserves.reserveA, reserveB: reserves.reserveB });
      } catch (error) {
        input.logger.debug('warmup_reserves_failed', {
          pool: poolAddress,
          error: (error as Error).message,
        });
      }
    }),
  );

  return { warmed, failed, slot: response.context.slot };
}
