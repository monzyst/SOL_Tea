/**
 * packages/policy — admission decisions and expense reservations.
 *
 * Two separate concerns, deliberately kept apart:
 *  1. `admitOpportunity` answers "may we attempt this at all?" from the signed
 *     policy, live concurrency and route health.
 *  2. `ReservationLedger` makes fee spending *reserved, not hoped for*. A
 *     reservation must exist before a transaction is signed, and settling it
 *     with the real fee closes the loop (V6 §06).
 *
 * Critical invariant: a deposit never resets spent budget. The period ledger
 * only advances on settle, and the period start is stamped once.
 */

import type { ReasonCode } from '../../domain/src';
import type { Policy } from '../../config/src';
import { resolvedNumber, unresolvedPolicyFields } from '../../config/src';

export interface AdmissionInput {
  readonly policy: Policy;
  readonly routeKey: string;
  readonly grossSurplusRaw: bigint;
  readonly principalRaw: bigint;
  readonly worstCaseNativeFeeRaw: bigint;
  readonly activePending: number;
  readonly routeFailures: number;
  readonly lastFailureAtUtc: string | null;
  readonly nowUtc: Date;
  readonly paused: boolean;
  /**
   * True only when execution is armed for this process. False in observe mode.
   * Kept separate from `paused` so the two states are never conflated in logs.
   */
  readonly executionArmed: boolean;
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reason: ReasonCode;
  readonly detail: Record<string, unknown>;
}

/**
 * Deterministic admission.
 *
 * ORDER MATTERS, and the order is the whole design:
 *
 *   1. Operator pause (a human decision) ...
 *   2. Policy completeness (fail closed on unresolved money values) ...
 *   3. Route health, concurrency, size, economics, fee caps ...
 *   4. Arming — "is execution switched on right now?" comes LAST.
 *
 * Arming is deliberately last because it is not an economic input. If it ran
 * first, observe-only mode would return PAUSED for every opportunity and the
 * engine would never evaluate a single quote — the mode would prove nothing, and
 * a dashboard would show an operator pause that no operator caused. Evaluating
 * economics first means observation produces the real verdict (NO_EDGE_AFTER_FEES,
 * FEE_LIMIT_REACHED, ...) and, when everything passes and we are simply not armed,
 * says so distinctly as LIVE_EXECUTION_DISARMED.
 *
 * A rejection always names the FIRST true blocker encountered in that order.
 */
export function admitOpportunity(input: AdmissionInput): AdmissionDecision {
  const p = input.policy.solArb;

  if (input.paused) {
    return { admitted: false, reason: 'PAUSED', detail: { source: 'emergency-or-file' } };
  }

  const unresolved = unresolvedPolicyFields(input.policy);
  if (unresolved.length > 0) {
    return { admitted: false, reason: 'POLICY_OR_CODE_DRIFT', detail: { unresolved } };
  }

  // Route quarantine after repeated failures — protects fees, not the market.
  if (input.routeFailures >= p.maxConsecutiveFailures) {
    return {
      admitted: false,
      reason: 'COOLDOWN_AFTER_FAILURE',
      detail: { routeFailures: input.routeFailures, threshold: p.maxConsecutiveFailures },
    };
  }
  if (input.lastFailureAtUtc) {
    const sinceFailure = input.nowUtc.getTime() - Date.parse(input.lastFailureAtUtc);
    if (sinceFailure >= 0 && sinceFailure < p.routeCooldownMs) {
      return {
        admitted: false,
        reason: 'COOLDOWN_AFTER_FAILURE',
        detail: { remainingMs: p.routeCooldownMs - sinceFailure },
      };
    }
  }

  const maxPending = resolvedNumber(p.maxConcurrentPending, 'solArb.maxConcurrentPending');
  if (input.activePending >= maxPending) {
    return {
      admitted: false,
      reason: 'MAX_CONCURRENT_PENDING',
      detail: { activePending: input.activePending, maxPending },
    };
  }

  const minPrincipal = BigInt(
    resolvedNumber(p.minPrincipalRawPerAttempt, 'solArb.minPrincipalRawPerAttempt'),
  );
  const maxPrincipal = BigInt(
    resolvedNumber(p.maxPrincipalRawPerAttempt, 'solArb.maxPrincipalRawPerAttempt'),
  );
  if (input.principalRaw < minPrincipal) {
    return {
      admitted: false,
      reason: 'SIZE_BELOW_MINIMUM',
      detail: { principalRaw: input.principalRaw.toString(), minPrincipal: minPrincipal.toString() },
    };
  }
  if (input.principalRaw > maxPrincipal) {
    return {
      admitted: false,
      reason: 'SIZE_BELOW_MINIMUM',
      // Deliberately the same reason as "too small": both mean the size is
      // outside the signed band, and the detail names which bound was crossed.
      detail: { principalRaw: input.principalRaw.toString(), maxPrincipal: maxPrincipal.toString() },
    };
  }

  // Economic test uses the net floor, never the gross approximation alone.
  const minNet = BigInt(resolvedNumber(p.minEconomicNetRaw, 'solArb.minEconomicNetRaw'));
  if (input.grossSurplusRaw <= 0n) {
    return {
      admitted: false,
      reason: 'NO_EDGE_AFTER_FEES',
      detail: { grossSurplusRaw: input.grossSurplusRaw.toString() },
    };
  }
  if (input.grossSurplusRaw < minNet) {
    return {
      admitted: false,
      reason: 'NO_EDGE_AFTER_FEES',
      detail: { grossSurplusRaw: input.grossSurplusRaw.toString(), minNetRaw: minNet.toString() },
    };
  }

  const perAttemptCap = BigInt(
    resolvedNumber(p.maxNativeFeePerAttemptLamports, 'solArb.maxNativeFeePerAttemptLamports'),
  );
  if (input.worstCaseNativeFeeRaw > perAttemptCap) {
    return {
      admitted: false,
      reason: 'FEE_LIMIT_REACHED',
      detail: {
        worstCaseNativeFeeRaw: input.worstCaseNativeFeeRaw.toString(),
        perAttemptCap: perAttemptCap.toString(),
      },
    };
  }

  // Economics pass. Only now does it matter whether execution is switched on.
  if (!input.executionArmed) {
    return {
      admitted: false,
      reason: 'LIVE_EXECUTION_DISARMED',
      // wouldAdmit:true is the observable proof of what observation measured: the
      // opportunity cleared every economic gate and was stopped only by arming.
      detail: {
        wouldAdmit: true,
        grossSurplusRaw: input.grossSurplusRaw.toString(),
        worstCaseNativeFeeRaw: input.worstCaseNativeFeeRaw.toString(),
      },
    };
  }

  return { admitted: true, reason: 'OK', detail: {} };
}

/* ------------------------------------------------------- expense reservations */

export type ReservationState = 'RESERVED' | 'SETTLED' | 'EXPIRED';

export interface Reservation {
  readonly reservationId: string;
  readonly intentId: string;
  readonly routeKey: string;
  readonly worstCaseNativeFeeRaw: bigint;
  readonly actualNativeFeeRaw: bigint | null;
  readonly state: ReservationState;
  readonly createdAtUtc: string;
  readonly closedAtUtc: string | null;
}

export class BudgetExhaustedError extends Error {
  constructor(
    readonly periodSpentRaw: bigint,
    readonly requestedRaw: bigint,
    readonly capRaw: bigint,
  ) {
    super(`fee budget exhausted: spent ${periodSpentRaw} + requested ${requestedRaw} > cap ${capRaw}`);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Reservation ledger. This in-memory implementation is the reference behaviour;
 * production replaces the store with the durable outbox described in
 * docs/ARCHITECTURE.md without changing these semantics.
 */
export class ReservationLedger {
  private readonly reservations = new Map<string, Reservation>();
  private periodSpentRaw = 0n;
  private readonly periodStartUtc: string;
  private readonly periodCapRaw: bigint | null;

  constructor(
    private readonly policy: Policy,
    clock: () => Date = () => new Date(),
  ) {
    // Observe-only is a first-class mode: an unresolved cap yields a null budget
    // (every reservation is refused) instead of crashing the process. Admission
    // already blocks that path with POLICY_OR_CODE_DRIFT, so this is a second,
    // independent guard rather than a bypass.
    this.periodCapRaw =
      policy.solArb.maxNativeFeePeriodLamports === 'REQUIRED_OWNER_BINDING'
        ? null
        : BigInt(
            resolvedNumber(
              policy.solArb.maxNativeFeePeriodLamports,
              'solArb.maxNativeFeePeriodLamports',
            ),
          );
    const configuredStart = policy.solArb.periodStartUtc;
    this.periodStartUtc =
      configuredStart === 'REQUIRED_OWNER_BINDING' ? clock().toISOString() : configuredStart;
  }

  get spentRaw(): bigint {
    return this.periodSpentRaw;
  }

  /** Null means "no budget has been granted" — i.e. observe-only. */
  get capRaw(): bigint | null {
    return this.periodCapRaw;
  }

  get isBudgeted(): boolean {
    return this.periodCapRaw !== null;
  }

  get periodStart(): string {
    return this.periodStartUtc;
  }

  /** Reserve the worst-case fee before signing; throws if the period cap breaks. */
  reserve(input: {
    reservationId: string;
    intentId: string;
    routeKey: string;
    worstCaseNativeFeeRaw: bigint;
    nowUtc?: Date;
  }): Reservation {
    if (this.reservations.has(input.reservationId)) {
      throw new Error(`duplicate reservation id: ${input.reservationId}`);
    }
    const capRaw = this.periodCapRaw;
    if (capRaw === null) {
      throw new BudgetExhaustedError(this.periodSpentRaw, input.worstCaseNativeFeeRaw, 0n);
    }
    const outstanding = this.outstandingRaw();
    const projected = this.periodSpentRaw + outstanding + input.worstCaseNativeFeeRaw;
    if (projected > capRaw) {
      throw new BudgetExhaustedError(
        this.periodSpentRaw + outstanding,
        input.worstCaseNativeFeeRaw,
        capRaw,
      );
    }

    const reservation: Reservation = {
      reservationId: input.reservationId,
      intentId: input.intentId,
      routeKey: input.routeKey,
      worstCaseNativeFeeRaw: input.worstCaseNativeFeeRaw,
      actualNativeFeeRaw: null,
      state: 'RESERVED',
      createdAtUtc: (input.nowUtc ?? new Date()).toISOString(),
      closedAtUtc: null,
    };
    this.reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  /** Settle with the *actual* on-chain fee. Only real spend reduces the budget. */
  settle(reservationId: string, actualNativeFeeRaw: bigint, nowUtc: Date = new Date()): Reservation {
    const existing = this.require(reservationId);
    if (existing.state !== 'RESERVED') {
      throw new Error(`reservation ${reservationId} is already ${existing.state}`);
    }
    if (actualNativeFeeRaw < 0n) throw new Error('actual fee cannot be negative');

    this.periodSpentRaw += actualNativeFeeRaw;
    const settled: Reservation = {
      ...existing,
      actualNativeFeeRaw,
      state: 'SETTLED',
      closedAtUtc: nowUtc.toISOString(),
    };
    this.reservations.set(reservationId, settled);
    return settled;
  }

  /** Release an unused reservation (e.g. the build failed before signing). */
  expire(reservationId: string, nowUtc: Date = new Date()): Reservation {
    const existing = this.require(reservationId);
    if (existing.state !== 'RESERVED') return existing;
    const expired: Reservation = { ...existing, state: 'EXPIRED', closedAtUtc: nowUtc.toISOString() };
    this.reservations.set(reservationId, expired);
    return expired;
  }

  activePending(): number {
    return [...this.reservations.values()].filter((r) => r.state === 'RESERVED').length;
  }

  outstandingRaw(): bigint {
    return [...this.reservations.values()]
      .filter((r) => r.state === 'RESERVED')
      .reduce((sum, r) => sum + r.worstCaseNativeFeeRaw, 0n);
  }

  snapshot(): Array<Record<string, unknown>> {
    return [...this.reservations.values()].map((r) => ({
      reservationId: r.reservationId,
      intentId: r.intentId,
      state: r.state,
      worstCaseNativeFeeRaw: r.worstCaseNativeFeeRaw.toString(),
      actualNativeFeeRaw: r.actualNativeFeeRaw?.toString() ?? null,
      createdAtUtc: r.createdAtUtc,
      closedAtUtc: r.closedAtUtc,
    }));
  }

  private require(reservationId: string): Reservation {
    const existing = this.reservations.get(reservationId);
    if (!existing) throw new Error(`unknown reservation: ${reservationId}`);
    return existing;
  }
}
