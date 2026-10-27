/**
 * apps/solana-worker/lifecycle — one full trading decision, end to end.
 *
 * This module exists because the previous revision's `main.ts` stopped at
 * "candidate admitted, logging a dry run" and left the execution path unwired
 * (audit T01). Everything downstream — reservation, intent, signing, submission,
 * settlement, reconciliation — was present as library code but never called in
 * sequence by a live process. A codebase whose hot path never runs is a library,
 * not a bot.
 *
 * The sequence below is the contract, and the ORDER is the safety property:
 *
 *   1. readiness gate            (coherent pair, fresh, same-ish slot)
 *   2. exact CLMM pricing        (refuses rather than extrapolating)
 *   3. adaptive priority fee     (refuses when it cannot price)
 *   4. policy admission          (caps, quarantine, concurrency)
 *   5. reserve + intent          (ONE transaction: budget + dedup together)
 *   6. executable SDK quote      (authoritative thresholds)
 *   7. sign + submit + await     (executor, with honest UNKNOWN)
 *   8. settle + reconcile        (actual fee, realised delta, route health)
 *
 * Every step can refuse, and each refusal maps to a distinct reason code so the
 * funnel explains "why no trade" without guesswork. A crash at any point leaves
 * either a complete intent or none — never a submission without a reservation.
 */

import type { Logger, Funnel, Metrics } from '../../../packages/obs/src';
import type { MarketStateStore } from '../../../packages/market/src';
import type { ChainConfig } from '../../../packages/config/src';
import type { Policy } from '../../../packages/config/src';
import type { Connection } from '@solana/web3.js';
import { admitOpportunity } from '../../../packages/policy/src';
import type { Store } from '../../../packages/store/src';
import { economicKey } from '../../../packages/store/src';
import type { PoolBinding } from '../../../packages/registry/src';
import type { PoolSnapshot } from '../../../chains/solana/src/whirlpool';
import type { LiquidityCache } from '../../../chains/solana/src/venues';
import type { Executor } from '../../../packages/executor/src';
import { estimateWorstCaseFeeLamports } from '../../../packages/executor/src';
import type { PriorityFeeEstimator } from '../../../packages/rpc/src/priority-fee';
import { quoteExactIn, type ExecutableQuote } from '../../../chains/solana/src/quoter';
import { discoverPairClmm, quoteIsFresh, type ClmmCandidate } from '../../../packages/strategies/src/arb-clmm';
import type { ReasonCode } from '../../../packages/domain/src';
import type { Reconciler } from '../../../packages/reconcile/src';

export interface LifecycleDeps {
  readonly logger: Logger;
  readonly funnel: Funnel;
  readonly metrics: Metrics;
  readonly market: MarketStateStore;
  /** Read connection for quoting. Separate from the executor's write path. */
  readonly connection: Connection;
  readonly chain: ChainConfig;
  readonly policy: Policy;
  readonly store: Store;
  readonly bindings: ReadonlyMap<string, PoolBinding>;
  readonly liquidity: LiquidityCache;
  readonly priorityFee: PriorityFeeEstimator;
  readonly executor: Executor | null;
  readonly reconciler: Reconciler | null;
  readonly settlementMint: string;
  readonly liveEnabled: boolean;
  readonly paused: boolean;
  readonly nowUtc?: () => Date;
  /** Stable id generator; injected so tests are deterministic. */
  readonly newId?: () => string;
}

export interface LifecycleOutcome {
  readonly reason: ReasonCode;
  readonly admitted: boolean;
  readonly intentId: string | null;
  readonly signature: string | null;
  readonly mode: 'observe' | 'dry-run' | 'live';
  readonly detail: Record<string, unknown>;
}

/** Timestamped unique id: sortable, collision-resistant enough for one host. */
function defaultId(prefix: string, now: Date): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${now.getTime().toString(36)}_${rand}`;
}

/**
 * Price a principal size and return the best exact candidate, or a refusal.
 *
 * Liquidity maps are read from cache only. A missing or stale map is a refusal —
 * refreshing here would put a network round-trip on the decision path and, worse,
 * would price against state fetched *after* the decision to make it.
 */
function priceExact(deps: LifecycleDeps, amountInRaw: bigint): {
  candidate: ClmmCandidate | null;
  reason: ReasonCode;
  detail: Record<string, unknown>;
} {
  const snapshots: PoolSnapshot[] = [];
  for (const address of deps.bindings.keys()) {
    const snapshot = deps.market.get(address);
    if (snapshot) snapshots.push(snapshot);
  }
  if (snapshots.length < 2) {
    return { candidate: null, reason: 'FEED_STALE', detail: { pools: snapshots.length } };
  }

  let best: ClmmCandidate | null = null;
  let lastReason: ReasonCode = 'QUOTES_UNAVAILABLE';
  let lastDetail: Record<string, unknown> = {};

  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      const a = snapshots[i] as PoolSnapshot;
      const b = snapshots[j] as PoolSnapshot;

      const readiness = deps.market.readiness(a.poolAddress, b.poolAddress);
      if (!readiness.ready) {
        lastReason = readiness.reason;
        lastDetail = readiness.detail;
        continue;
      }

      const mapA = deps.liquidity.peek(a.poolAddress);
      const mapB = deps.liquidity.peek(b.poolAddress);
      if (!mapA || !mapB) {
        lastReason = 'LIQUIDITY_UNREFERENCED';
        lastDetail = { missing: [!mapA ? a.poolAddress : null, !mapB ? b.poolAddress : null] };
        continue;
      }

      const { candidate, refusals } = discoverPairClmm({
        settlementMint: deps.settlementMint,
        poolA: a,
        liquidityA: {
          poolAddress: mapA.poolAddress,
          map: mapA.map,
          slot: mapA.slot,
          fetchedAtUtc: mapA.fetchedAtUtc,
        },
        poolB: b,
        liquidityB: {
          poolAddress: mapB.poolAddress,
          map: mapB.map,
          slot: mapB.slot,
          fetchedAtUtc: mapB.fetchedAtUtc,
        },
        amountInRaw,
        nowUtc: deps.nowUtc ? deps.nowUtc() : new Date(),
      });

      if (!candidate) {
        if (refusals.length > 0) {
          const first = refusals[0] as { reason: ReasonCode; detail: Record<string, unknown> };
          lastReason = first.reason;
          lastDetail = first.detail;
        }
        continue;
      }
      if (!best || candidate.grossSurplusRaw > best.grossSurplusRaw) best = candidate;
    }
  }

  if (!best) {
    return { candidate: null, reason: lastReason, detail: lastDetail };
  }
  return { candidate: best, reason: 'OK', detail: {} };
}

/**
 * Run one evaluation. Returns a structured outcome; never throws for a normal
 * refusal, and converts unexpected errors into a logged UNKNOWN-ish refusal.
 */
export async function evaluateOnce(deps: LifecycleDeps): Promise<LifecycleOutcome> {
  const now = deps.nowUtc ? deps.nowUtc() : new Date();
  const p = deps.policy.solArb;
  const mode = deps.chain.chain.executionMode;

  const refuse = (
    reason: ReasonCode,
    detail: Record<string, unknown> = {},
    admitted = false,
  ): LifecycleOutcome => {
    deps.funnel.markReason(reason);
    return { reason, admitted, intentId: null, signature: null, mode, detail };
  };

  // NOTE: there is deliberately NO early return on !deps.liveEnabled here.
  //
  // Observe mode must run the entire decision path — price, freshness, fee
  // estimation, sizing and admission — and let admission report
  // LIVE_EXECUTION_DISARMED at the END. Returning early would make observation a
  // no-op that proves nothing and mislabels itself PAUSED, so an operator would
  // see a pause they never set. Arming is a submission gate, not an input to
  // pricing; it is enforced in exactly one place (admission) and again at the
  // point of signing.
  if (deps.paused) return refuse('PAUSED', { source: 'control-plane' });

  // ---- principal sizing ----------------------------------------------------
  const minPrincipal = typeof p.minPrincipalRawPerAttempt === 'number' ? BigInt(p.minPrincipalRawPerAttempt) : 0n;
  const maxPrincipal =
    typeof p.maxPrincipalRawPerAttempt === 'number' ? BigInt(p.maxPrincipalRawPerAttempt) : minPrincipal;
  if (minPrincipal <= 0n) return refuse('SIZE_BELOW_MINIMUM', { minPrincipal: minPrincipal.toString() });

  // Size at the minimum: on a thin venue, a larger clip walks deeper into the
  // book and the marginal surplus falls, so the smallest admissible size is the
  // one most likely to prove the path. Growth is a later, evidence-driven step.
  const principal = minPrincipal > maxPrincipal ? maxPrincipal : minPrincipal;

  const priced = priceExact(deps, principal);
  if (!priced.candidate) return refuse(priced.reason, priced.detail);
  deps.funnel.markStage('DISCOVERED');

  const candidate = priced.candidate;

  // ---- quote freshness -----------------------------------------------------
  const liquidityAgeA = deps.liquidity.ageMs(candidate.buyPool) ?? Number.MAX_SAFE_INTEGER;
  const freshness = quoteIsFresh({
    candidate,
    nowUtc: now,
    maxQuoteAgeMs: deps.chain.market.maxQuoteAgeMs,
    liquidityAgeMs: liquidityAgeA,
    liquidityMaxAgeMs: deps.chain.market.liquidityMapMaxAgeMs,
  });
  if (!freshness.fresh) {
    return refuse(freshness.reason ?? 'FEED_STALE', freshness.detail ?? {});
  }

  deps.funnel.markStage('QUOTED');

  // ---- adaptive priority fee ----------------------------------------------
  let feeEstimate;
  try {
    feeEstimate = await deps.priorityFee.estimate();
  } catch (error) {
    return refuse('FEE_ESTIMATE_UNAVAILABLE', { error: (error as Error).message });
  }
  if (feeEstimate.source === 'unavailable' || feeEstimate.microLamports <= 0) {
    // No samples and no configured fallback: refusing is the only honest answer.
    return refuse('FEE_ESTIMATE_UNAVAILABLE', {
      samples: feeEstimate.sampleCount,
      nonZero: feeEstimate.nonZeroSamples,
    });
  }
  deps.metrics.set('fee.micro_lamports', feeEstimate.microLamports);

  const computeUnits = deps.chain.executor.maxComputeUnits;
  const worstCaseFee = estimateWorstCaseFeeLamports({
    signatureCount: 1,
    computeUnits,
    priorityFeeMicroLamports: feeEstimate.microLamports,
    // Two ATAs may need creating on a first run for a given mint pair.
    tokenAccountsToCreate: 2,
  });

  // ---- admission -----------------------------------------------------------
  const routeHealth = deps.store.routeHealth(candidate.key);
  const admission = admitOpportunity({
    policy: deps.policy,
    routeKey: candidate.key,
    grossSurplusRaw: candidate.grossSurplusRaw,
    principalRaw: candidate.amountInRaw,
    worstCaseNativeFeeRaw: worstCaseFee,
    activePending: deps.store.outstandingReservations().length,
    routeFailures: routeHealth.consecutiveFailures,
    lastFailureAtUtc: routeHealth.lastFailureAtUtc,
    nowUtc: now,
    paused: deps.paused,
    // Armed means the process may actually submit. Observe mode wires this to
    // false, so the economic verdict is still computed and reported.
    executionArmed: deps.liveEnabled,
  });

  if (!admission.admitted) {
    deps.funnel.markStage('REJECTED');
    return refuse(admission.reason, admission.detail);
  }
  deps.funnel.markStage('ADMITTED');

  // ---- intent + reservation (one transaction) ------------------------------
  const intentId = (deps.newId ?? ((prefix: string, at: Date) => defaultId(prefix, at)))('intent', now);
  const reservationId = (deps.newId ?? ((prefix: string, at: Date) => defaultId(prefix, at)))('resv', now);
  const periodStart = p.periodStartUtc !== 'REQUIRED_OWNER_BINDING' ? p.periodStartUtc : now.toISOString();
  const periodCap =
    typeof p.maxNativeFeePeriodLamports === 'number' ? BigInt(p.maxNativeFeePeriodLamports) : 0n;

  try {
    deps.store.insertIntentWithReservation({
      intentId,
      routeKey: candidate.key,
      // Dedup identity includes the slot the price was derived from, so a retry
      // in a LATER slot is a genuinely new opportunity, while a duplicate attempt
      // against the same state is refused.
      economicKey: economicKey({
        routeKey: candidate.key,
        principalRaw: candidate.amountInRaw,
        observedSlot: candidate.basedOnSlot,
      }),
      principalRaw: candidate.amountInRaw,
      worstCaseFeeRaw: worstCaseFee,
      reservationId,
      periodStartUtc: periodStart,
      periodCapRaw: periodCap,
      nowUtc: now,
    });
  } catch (error) {
    const code = (error as Error).name;
    if (code === 'StoreError') {
      const message = (error as Error).message;
      if (message.includes('budget')) return refuse('FEE_LIMIT_REACHED', { error: message });
      if (message.includes('already recorded')) {
        return refuse('MAX_CONCURRENT_PENDING', { error: message });
      }
    }
    deps.logger.error('intent_reservation_failed', { intentId, error: (error as Error).message });
    return refuse('TX_OUTCOME_UNKNOWN', { error: (error as Error).message });
  }
  deps.funnel.markStage('RESERVED');
  deps.metrics.inc('lifecycle.reserved');

  // Observe-only / dry-run stops here with real accounting recorded. Nothing is
  // signed, so there is no exposure; the funnel and the store both show exactly
  // what WOULD have happened, which is what makes the transition to live safe.
  if (mode !== 'live' || !deps.executor) {
    deps.store.expireReservation(reservationId, now, 'NOT_LIVE_MODE');
    deps.logger.info('candidate_observed', {
      intentId,
      routeKey: candidate.key,
      mode,
      surplusRaw: candidate.grossSurplusRaw.toString(),
      principalRaw: candidate.amountInRaw.toString(),
      priorityFeeMicroLamports: feeEstimate.microLamports,
      worstCaseFee: worstCaseFee.toString(),
      boundariesCrossed: candidate.boundariesCrossed,
      slot: candidate.basedOnSlot,
    });
    return {
      reason: 'OK',
      admitted: true,
      intentId,
      signature: null,
      mode,
      detail: {
        surplusRaw: candidate.grossSurplusRaw.toString(),
        priorityFeeMicroLamports: feeEstimate.microLamports,
        note: 'admitted and reserved; not signed in this mode',
      },
    };
  }

  // ---- executable quotes (authoritative thresholds) ------------------------
  const buyBinding = deps.bindings.get(candidate.buyPool);
  const sellBinding = deps.bindings.get(candidate.sellPool);
  if (!buyBinding || !sellBinding) {
    deps.store.expireReservation(reservationId, now, 'BINDING_MISSING');
    return refuse('POLICY_OR_CODE_DRIFT', { missing: true });
  }

  let buyQuote: ExecutableQuote;
  let sellQuote: ExecutableQuote;
  try {
    buyQuote = await quoteExactIn({
      connection: deps.connection,
      binding: buyBinding,
      programId: buyBinding.programId,
      inputMint: deps.settlementMint,
      amountIn: candidate.amountInRaw,
      slippageBps: p.maxSlippageBps,
    });
  } catch (error) {
    deps.store.expireReservation(reservationId, now, 'QUOTE_UNAVAILABLE');
    return refuse('QUOTES_UNAVAILABLE', { leg: 1, error: (error as Error).message });
  }

  try {
    sellQuote = await quoteExactIn({
      connection: deps.connection,
      binding: sellBinding,
      programId: sellBinding.programId,
      inputMint: buyQuote.aToB ? sellBinding.mintA : sellBinding.mintB,
      amountIn: buyQuote.expectedAmountOut,
      slippageBps: p.maxSlippageBps,
    });
  } catch (error) {
    deps.store.expireReservation(reservationId, now, 'QUOTE_UNAVAILABLE');
    return refuse('QUOTES_UNAVAILABLE', { leg: 2, error: (error as Error).message });
  }

  // The SDK quote is authoritative. If it says the cycle is not profitable the
  // CLMM discovery number was optimistic (or stale) and must not be traded.
  const executableNet = sellQuote.minimumAmountOut - candidate.amountInRaw;
  if (executableNet < BigInt(typeof p.minEconomicNetRaw === 'number' ? p.minEconomicNetRaw : 0)) {
    deps.store.expireReservation(reservationId, now, 'EDGE_GONE_AT_QUOTE');
    return refuse('NO_EDGE_AFTER_FEES', {
      executableNetRaw: executableNet.toString(),
      discoverySurplusRaw: candidate.grossSurplusRaw.toString(),
    });
  }

  // ---- sign + submit -------------------------------------------------------
  const result = await deps.executor.execute({
    intentId,
    routeKey: candidate.key,
    buyBinding,
    sellBinding,
    programId: buyBinding.programId,
    buyQuote,
    sellQuote,
    maxComputeUnits: computeUnits,
    priorityFeeMicroLamports: feeEstimate.microLamports,
    commitment: deps.chain.chain.commitment,
    quoteExpiresAtUtc: new Date(
      now.getTime() + deps.chain.executor.maxQuoteAgeMs,
    ).toISOString(),
  });

  deps.metrics.inc(`execution.${result.outcome.toLowerCase()}`);

  // ---- settle + reconcile --------------------------------------------------
  const settledFee = result.nativeFeeLamports ?? worstCaseFee;
  try {
    deps.store.settleReservation({
      reservationId,
      actualFeeRaw: settledFee,
      nowUtc: new Date(),
      intentState:
        result.outcome === 'INCLUDED'
          ? 'INCLUDED'
          : result.outcome === 'AWAITING_FINALITY'
            ? 'AWAITING_FINALITY'
            : result.outcome === 'REVERTED'
              ? 'FAILED'
              : 'SUBMITTED',
    });
  } catch (error) {
    // Settlement bookkeeping failure is loud but not fatal: the journal still
    // holds the truth, and startup recovery will re-derive it.
    deps.logger.error('reservation_settle_failed', {
      intentId,
      reservationId,
      error: (error as Error).message,
    });
  }

  const routeOutcome =
    result.outcome === 'INCLUDED'
      ? 'SUCCESS'
      : result.outcome === 'REVERTED'
        ? 'REVERTED'
        : result.outcome === 'UNKNOWN'
          ? 'UNKNOWN'
          : 'FAILED';

  const health = deps.store.recordRouteOutcome({
    routeKey: candidate.key,
    outcome: routeOutcome,
    nowUtc: new Date(),
    quarantineAfter: p.maxConsecutiveFailures,
    quarantineMs: p.routeQuarantineMs,
  });
  if (health.quarantinedUntil) {
    deps.logger.warn('route_quarantined', {
      routeKey: candidate.key,
      consecutiveFailures: health.consecutiveFailures,
      quarantinedUntil: health.quarantinedUntil,
    });
  }

  if (result.signature && deps.reconciler && result.outcome !== 'NOT_SENT') {
    try {
      const reconciliation = await deps.reconciler.reconcileIntent({
        intentId,
        routeKey: candidate.key,
        signature: result.signature,
        settlementMint: deps.settlementMint,
        ownerAddress: String(deps.chain.executor.operatorPublicAddress),
      });
      deps.store.recordSettlement({
        signature: result.signature,
        intentId,
        routeKey: candidate.key,
        verdict: reconciliation.verdict,
        realisedDeltaRaw: reconciliation.realisedDeltaRaw,
        feeLamports: reconciliation.feeLamports,
        slot: result.slot,
        nowUtc: new Date(),
        note: reconciliation.reason,
      });
    } catch (error) {
      deps.logger.warn('reconcile_failed_deferred', {
        intentId,
        signature: result.signature,
        error: (error as Error).message,
      });
    }
  }

  deps.funnel.markStage(result.outcome === 'INCLUDED' ? 'EXECUTED' : 'EXECUTION_FAILED');

  const mappedReason: ReasonCode =
    result.outcome === 'INCLUDED'
      ? 'OK'
      : result.outcome === 'AWAITING_FINALITY'
        ? 'OK'
        : result.outcome === 'UNKNOWN'
          ? 'TX_OUTCOME_UNKNOWN'
          : result.outcome === 'REVERTED'
            ? 'NO_EDGE_AFTER_FEES'
            : 'QUOTES_UNAVAILABLE';

  return {
    reason: mappedReason,
    admitted: true,
    intentId,
    signature: result.signature,
    mode,
    detail: {
      outcome: result.outcome,
      stage: result.stage,
      error: result.error,
      feeLamports: result.nativeFeeLamports?.toString() ?? null,
    },
  };
}
