/**
 * chains/solana/src/venues — venue-level state assembly for honest discovery quotes.
 *
 * A Whirlpool account alone is not enough to price a trade. It carries the
 * current sqrt price, the active liquidity and a tick spacing — but the
 * liquidity that applies *ahead* of the current tick lives in the tick arrays,
 * which are separate accounts. Pricing from the pool account alone means
 * assuming the active liquidity persists across every boundary, which is exactly
 * the overstatement this module removes.
 *
 * Cost control. Tick arrays are fetched only around the current tick (the walk
 * rarely needs more than one array each way), cached per pool keyed by the slot
 * they were read at, and refreshed out-of-band. A quote that would need liquidity
 * beyond the cached window REFUSES rather than extrapolating — the refusal is
 * cheap, a wrong quote is not.
 *
 * Everything here is keyed to the pool's own `tickSpacing`, because tick array
 * indexing is `floor(tick / (tickSpacing * 88))` and gets that wrong for negative
 * ticks if implemented with plain integer division.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import { PDAUtil, WhirlpoolContext } from '@orca-so/whirlpools-sdk';
import type { Logger } from '../../../packages/obs/src';
import type { PoolBinding } from '../../../packages/registry/src';
import {
  TICK_ARRAY_SIZE,
  decodeTickArray,
  walkExactIn,
  LiquidityMap,
  type InitializedTick,
  type WalkResult,
} from './clmm';

/** Number of tick arrays to load on each side of the current tick. */
export const DEFAULT_ARRAY_SPAN = 2;

export class VenueStateError extends Error {
  constructor(
    readonly poolAddress: string,
    readonly code: 'NO_ACCOUNT' | 'WRONG_OWNER' | 'BAD_SIZE' | 'NO_MAP',
    message: string,
  ) {
    super(`venue state unavailable for ${poolAddress} (${code}): ${message}`);
    this.name = 'VenueStateError';
  }
}

/**
 * Tick-array index containing `tick`.
 *
 * Solana/Rust integer division truncates toward zero, so `Math.floor` is
 * REQUIRED here: with tick=-5 and 88 ticks per array the answer must be -1, not
 * 0. Getting this wrong silently reads the wrong array (and therefore the wrong
 * liquidity) for every negative tick — which is most of the WSOL/USDC range.
 */
export function tickArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tickIndex / ticksPerArray) * ticksPerArray;
}

/** Ordered list of array start indices to load, centred on the current tick. */
export function tickArrayIndicesAround(input: {
  tickIndex: number;
  tickSpacing: number;
  span?: number;
}): number[] {
  const span = Math.max(1, input.span ?? DEFAULT_ARRAY_SPAN);
  const ticksPerArray = input.tickSpacing * TICK_ARRAY_SIZE;
  const centreIndex = Math.floor(input.tickIndex / ticksPerArray);
  const out: number[] = [];
  for (let i = centreIndex - span; i <= centreIndex + span; i += 1) {
    out.push(i * ticksPerArray);
  }
  return out;
}

export interface LiquiditySnapshot {
  readonly poolAddress: string;
  readonly map: LiquidityMap;
  readonly slot: number;
  readonly arraysLoaded: number;
  readonly fetchedAtUtc: string;
  readonly fetchedAtMonoNs: bigint;
}

/**
 * Fetch and assemble the liquidity map for one pool.
 *
 * Uses one `getMultipleAccountsInfoAndContext` call for every array, so the
 * whole map is read at a single slot. Reading arrays at different slots would
 * mix two states and produce a map that never existed on chain.
 */
export async function fetchLiquidityMap(input: {
  connection: Connection;
  binding: PoolBinding;
  tickIndex: number;
  /** Active liquidity at `tickIndex`, from the pool account. */
  liquidity: bigint;
  span?: number;
  logger: Logger;
}): Promise<LiquiditySnapshot> {
  const programId = new PublicKey(input.binding.programId);
  const poolKey = new PublicKey(input.binding.address);
  const starts = tickArrayIndicesAround({
    tickIndex: input.tickIndex,
    tickSpacing: input.binding.tickSpacing,
    span: input.span,
  });

  const addresses = starts.map(
    (startTickIndex) =>
      PDAUtil.getTickArray(programId, poolKey, startTickIndex).publicKey,
  );

  const response = await input.connection.getMultipleAccountsInfoAndContext(addresses, 'confirmed');
  const ticks: InitializedTick[] = [];
  let arraysLoaded = 0;

  response.value.forEach((account, index) => {
    if (!account) {
      input.logger.debug('tick_array_missing', {
        pool: input.binding.address,
        startTickIndex: starts[index],
      });
      return;
    }
    if (!account.owner.equals(programId)) {
      input.logger.warn('tick_array_wrong_owner', {
        pool: input.binding.address,
        startTickIndex: starts[index],
        owner: account.owner.toBase58(),
      });
      return;
    }
    try {
      const decoded = decodeTickArray(account.data, input.binding.tickSpacing);
      // Guard: an array must carry the start tick we asked for.
      if (decoded.startTickIndex !== starts[index]) {
        input.logger.warn('tick_array_start_mismatch', {
          pool: input.binding.address,
          expected: starts[index],
          actual: decoded.startTickIndex,
        });
        return;
      }
      ticks.push(...decoded.ticks);
      arraysLoaded += 1;
    } catch (error) {
      input.logger.warn('tick_array_decode_failed', {
        pool: input.binding.address,
        startTickIndex: starts[index],
        error: (error as Error).message,
      });
    }
  });

  return {
    poolAddress: input.binding.address,
    map: new LiquidityMap({
      ticks,
      liquidityAtReference: input.liquidity,
      referenceTick: input.tickIndex,
    }),
    slot: response.context.slot,
    arraysLoaded,
    fetchedAtUtc: new Date().toISOString(),
    fetchedAtMonoNs: process.hrtime.bigint(),
  };
}

/**
 * Exact-in quote for one pool leg using the liquidity map.
 *
 * Returns the walk verbatim so the caller can distinguish "priced, zero output"
 * from "refused, cannot price" — the two need different reason codes and only
 * one of them is a market observation.
 */
export function quoteLegExactIn(input: {
  snapshot: LiquiditySnapshot;
  binding: PoolBinding;
  sqrtPriceX64: bigint;
  tickIndex: number;
  amountIn: bigint;
  aToB: boolean;
  feeRatePpm: number;
}): WalkResult {
  return walkExactIn({
    amountIn: input.amountIn,
    sqrtPriceX64: input.sqrtPriceX64,
    tickIndex: input.tickIndex,
    liquidityMap: input.snapshot.map,
    feeRatePpm: input.feeRatePpm,
    aToB: input.aToB,
  });
}

/**
 * Short-lived cache of liquidity maps.
 *
 * Keyed by pool and stamped with the slot the map was read at. A map older than
 * `maxAgeMs` is not used: liquidity moves, and a stale map prices against
 * positions that may already be gone.
 */
export class LiquidityCache {
  private readonly entries = new Map<string, LiquiditySnapshot>();
  private readonly inFlight = new Map<string, Promise<LiquiditySnapshot>>();

  constructor(
    private readonly options: {
      connection: Connection;
      logger: Logger;
      maxAgeMs: number;
      span?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  ageMs(poolAddress: string): number | null {
    const entry = this.entries.get(poolAddress);
    if (!entry) return null;
    return this.now() - Date.parse(entry.fetchedAtUtc);
  }

  /** Fresh map if cached, else null — never blocks. */
  peek(poolAddress: string): LiquiditySnapshot | null {
    const entry = this.entries.get(poolAddress);
    if (!entry) return null;
    return this.now() - Date.parse(entry.fetchedAtUtc) <= this.options.maxAgeMs ? entry : null;
  }

  /** Refresh a pool's map, coalescing concurrent requests for the same pool. */
  async refresh(input: {
    binding: PoolBinding;
    tickIndex: number;
    liquidity: bigint;
  }): Promise<LiquiditySnapshot> {
    const key = input.binding.address;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fetchLiquidityMap({
      connection: this.options.connection,
      binding: input.binding,
      tickIndex: input.tickIndex,
      liquidity: input.liquidity,
      span: this.options.span,
      logger: this.options.logger,
    })
      .then((snapshot) => {
        this.entries.set(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(poolAddress: string): void {
    this.entries.delete(poolAddress);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  snapshot(): Array<Record<string, unknown>> {
    return [...this.entries.values()].map((entry) => ({
      pool: entry.poolAddress,
      slot: entry.slot,
      arraysLoaded: entry.arraysLoaded,
      initializedTicks: entry.map.size,
      tickRange: [entry.map.minTick, entry.map.maxTick],
      ageMs: this.ageMs(entry.poolAddress),
    }));
  }
}

/** Program-id helper kept here so callers never construct a stray context. */
export function whirlpoolProgramId(binding: PoolBinding): PublicKey {
  return new PublicKey(binding.programId);
}

/**
 * Reference to the SDK context type is kept so `venues` and `quoter` cannot
 * drift onto different SDK entry points without a compile error.
 */
export type VenueSdkContext = ReturnType<typeof WhirlpoolContext.from>;
