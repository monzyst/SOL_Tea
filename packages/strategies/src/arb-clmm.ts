/**
 * packages/strategies/arb-clmm — cycle discovery priced by the real liquidity map.
 *
 * This is the production pricing path. `arb.ts` remains as the fast, cheap
 * ranking pass (constant-product over vault reserves), and its output is used
 * ONLY to shortlist which pool pairs deserve an exact walk. The rule enforced
 * here is the one the audit asked for: a candidate that has not been priced by
 * the exact liquidity walk is not admissible, and a walk that refuses produces a
 * distinct reason code rather than an optimistic number.
 *
 * Why two passes at all: an exact walk needs tick arrays, which are extra RPC
 * reads. Doing that for every pair on every tick would put network I/O on the
 * hot path for candidates that are obviously unprofitable. The cheap pass is a
 * filter, never an authority — and the code below makes that explicit by
 * returning a `pricing` field that says which pass produced the number.
 */

import type { LiquidityMap, WalkResult } from '../../../chains/solana/src/clmm';
import { walkExactIn } from '../../../chains/solana/src/clmm';
import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import type { ReasonCode, RouteIdentity } from '../../domain/src';
import { routeKey } from '../../domain/src';

export interface PoolLiquidity {
  readonly poolAddress: string;
  readonly map: LiquidityMap;
  readonly slot: number;
  readonly fetchedAtUtc: string;
}

export interface ClmmCandidate {
  readonly route: RouteIdentity;
  readonly key: string;
  readonly buyPool: string;
  readonly sellPool: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  /** amountOut - amountIn, i.e. before native costs. */
  readonly grossSurplusRaw: bigint;
  readonly basedOnSlot: number;
  readonly createdAtUtc: string;
  /** Which pricing pass produced these numbers. Always 'exact-clmm' here. */
  readonly pricing: 'exact-clmm';
  /** Boundaries the walk crossed — a proxy for how fragile the quote is. */
  readonly boundariesCrossed: number;
  /** Fee actually deducted by the two legs, in settlement raw units. */
  readonly legFeesRaw: bigint;
}

export interface ClmmRefusal {
  readonly buyPool: string;
  readonly sellPool: string;
  readonly reason: ReasonCode;
  readonly detail: Record<string, unknown>;
}

export interface ClmmEvaluation {
  readonly candidate: ClmmCandidate | null;
  readonly refusal: ClmmRefusal | null;
}

/** Map a walk refusal to the reason code the funnel records. */
function refusalReason(walk: WalkResult): ReasonCode {
  switch (walk.refusal) {
    case 'LIQUIDITY_UNREFERENCED':
      return 'LIQUIDITY_UNREFERENCED';
    case 'PRICE_LIMIT':
      return 'TICK_BOUNDARY_CROSSED';
    case 'ZERO_LIQUIDITY':
    case 'AMOUNT_TOO_LARGE':
    default:
      return 'QUOTES_UNAVAILABLE';
  }
}

/**
 * Evaluate one directed cycle with exact CLMM math.
 *
 * Both legs are walked independently from their own live state. A refusal on
 * either leg refuses the whole candidate: a cycle is only as trustworthy as its
 * weaker side, and substituting an approximation for one leg would hide exactly
 * the error this module exists to prevent.
 */
export function evaluateCycleClmm(input: {
  settlementMint: string;
  buy: PoolSnapshot;
  buyLiquidity: PoolLiquidity;
  sell: PoolSnapshot;
  sellLiquidity: PoolLiquidity;
  amountInRaw: bigint;
  nowUtc?: Date;
}): ClmmEvaluation {
  const { buy, sell, settlementMint, amountInRaw } = input;

  if (buy.poolAddress === sell.poolAddress) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'QUOTES_UNAVAILABLE',
        detail: { note: 'buy and sell pool are identical' },
      },
    };
  }
  if (amountInRaw <= 0n) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'SIZE_BELOW_MINIMUM',
        detail: { amountInRaw: amountInRaw.toString() },
      },
    };
  }

  // Leg 1: settlement -> base. aToB depends on which side settlement sits.
  const settlementIsA = buy.binding.mintA === settlementMint;
  if (!settlementIsA && buy.binding.mintB !== settlementMint) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'POLICY_OR_CODE_DRIFT',
        detail: { note: 'buy pool does not contain the settlement mint' },
      },
    };
  }

  const leg1 = walkExactIn({
    amountIn: amountInRaw,
    sqrtPriceX64: buy.sqrtPriceX64,
    tickIndex: buy.tickIndex,
    liquidityMap: input.buyLiquidity.map,
    feeRatePpm: buy.feeRatePpm,
    aToB: settlementIsA,
  });
  if (!leg1.ok) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: refusalReason(leg1),
        detail: { leg: 1, refusal: leg1.refusal },
      },
    };
  }
  if (leg1.amountOut <= 0n) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'QUOTES_UNAVAILABLE',
        detail: { leg: 1, note: 'zero output' },
      },
    };
  }

  // Leg 2: base -> settlement on the other pool, in the opposite direction.
  const sellSettlementIsA = sell.binding.mintA === settlementMint;
  if (!sellSettlementIsA && sell.binding.mintB !== settlementMint) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'POLICY_OR_CODE_DRIFT',
        detail: { note: 'sell pool does not contain the settlement mint' },
      },
    };
  }

  const leg2 = walkExactIn({
    amountIn: leg1.amountOut,
    sqrtPriceX64: sell.sqrtPriceX64,
    tickIndex: sell.tickIndex,
    liquidityMap: input.sellLiquidity.map,
    feeRatePpm: sell.feeRatePpm,
    // Base leaves the wallet into the sell pool, so the input side is the base.
    aToB: !sellSettlementIsA,
  });
  if (!leg2.ok) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: refusalReason(leg2),
        detail: { leg: 2, refusal: leg2.refusal },
      },
    };
  }
  if (leg2.amountOut <= 0n) {
    return {
      candidate: null,
      refusal: {
        buyPool: buy.poolAddress,
        sellPool: sell.poolAddress,
        reason: 'QUOTES_UNAVAILABLE',
        detail: { leg: 2, note: 'zero output' },
      },
    };
  }

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
    candidate: {
      route,
      key: routeKey(route),
      buyPool: buy.poolAddress,
      sellPool: sell.poolAddress,
      amountInRaw,
      amountOutRaw: leg2.amountOut,
      grossSurplusRaw: leg2.amountOut - amountInRaw,
      basedOnSlot: Math.min(buy.slot, sell.slot, input.buyLiquidity.slot, input.sellLiquidity.slot),
      createdAtUtc: (input.nowUtc ?? new Date()).toISOString(),
      pricing: 'exact-clmm',
      boundariesCrossed: leg1.boundariesCrossed + leg2.boundariesCrossed,
      legFeesRaw: leg1.feeAmount + leg2.feeAmount,
    },
    refusal: null,
  };
}

/** Enumerate both directions and return the better exact candidate. */
export function discoverPairClmm(input: {
  settlementMint: string;
  poolA: PoolSnapshot;
  liquidityA: PoolLiquidity;
  poolB: PoolSnapshot;
  liquidityB: PoolLiquidity;
  amountInRaw: bigint;
  nowUtc?: Date;
}): { candidate: ClmmCandidate | null; refusals: ClmmRefusal[] } {
  const directions = [
    evaluateCycleClmm({
      settlementMint: input.settlementMint,
      buy: input.poolA,
      buyLiquidity: input.liquidityA,
      sell: input.poolB,
      sellLiquidity: input.liquidityB,
      amountInRaw: input.amountInRaw,
      nowUtc: input.nowUtc,
    }),
    evaluateCycleClmm({
      settlementMint: input.settlementMint,
      buy: input.poolB,
      buyLiquidity: input.liquidityB,
      sell: input.poolA,
      sellLiquidity: input.liquidityA,
      amountInRaw: input.amountInRaw,
      nowUtc: input.nowUtc,
    }),
  ];

  const refusals = directions.map((d) => d.refusal).filter((r): r is ClmmRefusal => r !== null);
  const candidates = directions
    .map((d) => d.candidate)
    .filter((c): c is ClmmCandidate => c !== null);

  let best: ClmmCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.grossSurplusRaw > best.grossSurplusRaw) best = candidate;
  }
  return { candidate: best, refusals };
}

/**
 * Whether a candidate's quote is still safe to act on.
 *
 * Two independent ages matter: the pool state it was derived from, and the
 * liquidity map that priced it. Either being stale invalidates the number.
 */
export function quoteIsFresh(input: {
  candidate: ClmmCandidate;
  nowUtc: Date;
  maxQuoteAgeMs: number;
  liquidityAgeMs: number;
  liquidityMaxAgeMs: number;
}): { fresh: boolean; reason?: ReasonCode; detail?: Record<string, unknown> } {
  const age = input.nowUtc.getTime() - Date.parse(input.candidate.createdAtUtc);
  if (age > input.maxQuoteAgeMs) {
    return {
      fresh: false,
      reason: 'FEED_STALE',
      detail: { quoteAgeMs: age, maxQuoteAgeMs: input.maxQuoteAgeMs },
    };
  }
  if (input.liquidityAgeMs > input.liquidityMaxAgeMs) {
    return {
      fresh: false,
      reason: 'LIQUIDITY_UNREFERENCED',
      detail: { liquidityAgeMs: input.liquidityAgeMs, liquidityMaxAgeMs: input.liquidityMaxAgeMs },
    };
  }
  return { fresh: true };
}
