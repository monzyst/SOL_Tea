/**
 * packages/strategies — two-pool spatial cycle discovery and sizing.
 *
 * Economic definition (V6 §00/§01): a *spatial* arbitrage is buy leg + sell leg
 * over two DISTINCT pools forming a closed asset cycle. Borrowing is liquidity,
 * not profit. A one-way swap or a single-pool round trip is not a candidate.
 *
 * The strategy layer never signs and never quotes executably: it ranks
 * candidates from live coherent state so the expensive SDK quote is spent only
 * on the most promising attempt.
 */

import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import { quoteExactInConstantProduct } from '../../../chains/solana/src/whirlpool';
import type { RouteIdentity } from '../../domain/src';
import { routeKey } from '../../domain/src';

export interface CycleCandidate {
  readonly route: RouteIdentity;
  readonly key: string;
  /** Buy on this pool (settlement -> base). */
  readonly buyPool: string;
  /** Sell on this pool (base -> settlement). */
  readonly sellPool: string;
  readonly amountInRaw: bigint;
  /** Approximate output of the closed cycle, before native costs. */
  readonly amountOutRaw: bigint;
  /** amountOut - amountIn (may be <= 0). */
  readonly grossSurplusRaw: bigint;
  readonly basedOnSlot: number;
  readonly createdAtUtc: string;
}

/** `settlement -> base` is "buy" (we acquire the base token); the reverse is "sell". */
export type LegDirection = 'SETTLEMENT_TO_BASE' | 'BASE_TO_SETTLEMENT';

export function legReserves(
  snapshot: PoolSnapshot,
  settlementMint: string,
  direction: LegDirection,
): { reserveIn: bigint; reserveOut: bigint; aToB: boolean } | null {
  const { reserveA, reserveB, binding } = snapshot;
  if (reserveA === null || reserveB === null) return null;
  const settlementIsA = binding.mintA === settlementMint;
  if (!settlementIsA && binding.mintB !== settlementMint) return null;

  // A->B means selling token A into the pool.
  const inputIsA = direction === 'SETTLEMENT_TO_BASE' ? settlementIsA : !settlementIsA;
  return inputIsA
    ? { reserveIn: reserveA, reserveOut: reserveB, aToB: true }
    : { reserveIn: reserveB, reserveOut: reserveA, aToB: false };
}

/**
 * Evaluate one directed cycle (buy at `buy`, sell at `sell`) for a fixed input
 * size. Returns null when either leg lacks reserves or the pool pair is invalid.
 */
export function evaluateCycle(input: {
  settlementMint: string;
  buy: PoolSnapshot;
  sell: PoolSnapshot;
  amountInRaw: bigint;
  nowUtc?: Date;
}): CycleCandidate | null {
  const { buy, sell, settlementMint, amountInRaw } = input;
  if (buy.poolAddress === sell.poolAddress) return null;
  if (amountInRaw <= 0n) return null;

  const buyLeg = legReserves(buy, settlementMint, 'SETTLEMENT_TO_BASE');
  // Leg 2 sells the base token back into the sell pool, so it enters on the base
  // side: `BASE_TO_SETTLEMENT` gives reserveIn = base, reserveOut = settlement.
  const sellLeg = legReserves(sell, settlementMint, 'BASE_TO_SETTLEMENT');
  if (!buyLeg || !sellLeg) return null;

  // Leg 1: settlement -> base on the "buy" pool.
  const baseOut = quoteExactInConstantProduct({
    amountIn: amountInRaw,
    reserveIn: buyLeg.reserveIn,
    reserveOut: buyLeg.reserveOut,
    feeRatePpm: buy.feeRatePpm,
  });
  if (baseOut <= 0n) return null;

  // Leg 2: base -> settlement on the "sell" pool.
  const settlementOut = quoteExactInConstantProduct({
    amountIn: baseOut,
    reserveIn: sellLeg.reserveIn,
    reserveOut: sellLeg.reserveOut,
    feeRatePpm: sell.feeRatePpm,
  });
  if (settlementOut <= 0n) return null;

  const route: RouteIdentity = {
    chainId: 'solana-mainnet',
    settlementMint,
    poolBuy: buy.poolAddress,
    poolSell: sell.poolAddress,
    dexFamilyBuy: buy.binding.dexFamily,
    dexFamilySell: sell.binding.dexFamily,
    poolVersionBuy: buy.binding.poolVersion,
    poolVersionSell: sell.binding.poolVersion,
  };

  return {
    route,
    key: routeKey(route),
    buyPool: buy.poolAddress,
    sellPool: sell.poolAddress,
    amountInRaw,
    amountOutRaw: settlementOut,
    grossSurplusRaw: settlementOut - amountInRaw,
    basedOnSlot: Math.min(buy.slot, sell.slot),
    createdAtUtc: (input.nowUtc ?? new Date()).toISOString(),
  };
}

/**
 * Enumerate both directions of a pool pair. Exactly two candidates exist, and
 * with positive fees they cannot both be profitable — a useful test invariant.
 */
export function discoverPair(input: {
  settlementMint: string;
  poolA: PoolSnapshot;
  poolB: PoolSnapshot;
  amountInRaw: bigint;
  nowUtc?: Date;
}): CycleCandidate[] {
  const { settlementMint, poolA, poolB, amountInRaw, nowUtc } = input;
  const candidates = [
    evaluateCycle({ settlementMint, buy: poolA, sell: poolB, amountInRaw, nowUtc }),
    evaluateCycle({ settlementMint, buy: poolB, sell: poolA, amountInRaw, nowUtc }),
  ];
  return candidates.filter((c): c is CycleCandidate => c !== null);
}

export function bestCandidate(candidates: readonly CycleCandidate[]): CycleCandidate | null {
  let best: CycleCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.grossSurplusRaw > best.grossSurplusRaw) best = candidate;
  }
  return best;
}
