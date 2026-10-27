/**
 * Policy and reservation-ledger behaviour.
 *
 * The ledger invariant under test: reserving does not spend, only settling
 * spends, and an expired reservation returns its headroom.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitOpportunity, BudgetExhaustedError, ReservationLedger } from '../../packages/policy/src';
import type { Policy } from '../../packages/config/src';

function resolvedPolicy(overrides: Partial<Policy['solArb']> = {}): Policy {
  return {
    schemaVersion: 'v6.0',
    solArb: {
      maxBorrowRaw: 1_000_000_000,
      maxPrincipalRawPerAttempt: 100_000_000,
      minPrincipalRawPerAttempt: 1_000_000,
      minOnchainSurplusRaw: 10_000,
      minEconomicNetRaw: 20_000,
      maxSlippageBps: 30,
      maxNativeFeePerAttemptLamports: 200_000,
      maxNativeFeePeriodLamports: 1_000_000,
      periodStartUtc: '2026-10-27T00:00:00.000Z',
      maxConcurrentPending: 1,
      routeCooldownMs: 15_000,
      maxConsecutiveFailures: 3,
      ...overrides,
    },
    accounting: {
      reportingCurrency: 'USDC',
      rounding: { cost: 'CEILING', proceeds: 'FLOOR' },
    },
    control: { pauseFile: 'var/PAUSE', maxDailyLossRaw: 0 },
  };
}

function unresolvedPolicy(): Policy {
  const policy = resolvedPolicy();
  return {
    ...policy,
    solArb: { ...policy.solArb, minEconomicNetRaw: 'REQUIRED_OWNER_BINDING' as never },
  };
}

const baseInput = {
  routeKey: 'route-1',
  grossSurplusRaw: 1_000_000n,
  principalRaw: 10_000_000n,
  worstCaseNativeFeeRaw: 100_000n,
  activePending: 0,
  routeFailures: 0,
  lastFailureAtUtc: null,
  nowUtc: new Date('2026-10-27T01:00:00.000Z'),
  paused: false,
  executionArmed: true,
};

test('a healthy candidate is admitted', () => {
  const decision = admitOpportunity({ ...baseInput, policy: resolvedPolicy() });
  assert.equal(decision.admitted, true);
  assert.equal(decision.reason, 'OK');
});

test('emergency pause wins over every other gate', () => {
  const decision = admitOpportunity({ ...baseInput, policy: resolvedPolicy(), paused: true });
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'PAUSED');
});

test('observe mode evaluates economics, then reports DISARMED rather than PAUSED', () => {
  // The distinction matters: PAUSED means a human stopped trading, DISARMED means
  // the opportunity was measured and merely could not be submitted. Conflating
  // them makes an operator chase a pause nobody set, and hides whether the edge
  // existed at all.
  const decision = admitOpportunity({
    ...baseInput,
    policy: resolvedPolicy(),
    executionArmed: false,
  });
  assert.equal(decision.reason, 'LIVE_EXECUTION_DISARMED');
  assert.equal(decision.detail.wouldAdmit, true, 'a passing opportunity is reported as would-admit');

  // ... and an opportunity that fails economics must still report the economic
  // reason, NOT DISARMED: disarming must never mask a real rejection.
  const noEdge = admitOpportunity({
    ...baseInput,
    policy: resolvedPolicy(),
    grossSurplusRaw: 1n,
    executionArmed: false,
  });
  assert.equal(noEdge.reason, 'NO_EDGE_AFTER_FEES');
});

test('unresolved owner bindings block admission', () => {
  const decision = admitOpportunity({ ...baseInput, policy: unresolvedPolicy() });
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'POLICY_OR_CODE_DRIFT');
});

test('concurrency, cooldown and thin edge each name their own reason', () => {
  assert.equal(
    admitOpportunity({ ...baseInput, policy: resolvedPolicy(), activePending: 1 }).reason,
    'MAX_CONCURRENT_PENDING',
  );
  assert.equal(
    admitOpportunity({
      ...baseInput,
      policy: resolvedPolicy(),
      lastFailureAtUtc: '2026-10-27T00:59:55.000Z',
    }).reason,
    'COOLDOWN_AFTER_FAILURE',
  );
  assert.equal(
    admitOpportunity({ ...baseInput, policy: resolvedPolicy(), grossSurplusRaw: 5n }).reason,
    'NO_EDGE_AFTER_FEES',
  );
});

test('reservations cap the period and release on expiry', () => {
  const ledger = new ReservationLedger(resolvedPolicy());

  ledger.reserve({
    reservationId: 'r1',
    intentId: 'i1',
    routeKey: 'route-1',
    worstCaseNativeFeeRaw: 200_000n,
  });
  assert.equal(ledger.outstandingRaw(), 200_000n);
  assert.equal(ledger.spentRaw, 0n, 'reserving must not spend');

  // 5 x 200k = 1M exactly at the cap; a 6th must fail while they are outstanding.
  for (let i = 2; i <= 5; i += 1) {
    ledger.reserve({
      reservationId: `r${i}`,
      intentId: `i${i}`,
      routeKey: 'route-1',
      worstCaseNativeFeeRaw: 200_000n,
    });
  }
  assert.throws(
    () =>
      ledger.reserve({
        reservationId: 'r6',
        intentId: 'i6',
        routeKey: 'route-1',
        worstCaseNativeFeeRaw: 200_000n,
      }),
    BudgetExhaustedError,
  );

  // Expiring releases headroom without spending.
  ledger.expire('r1');
  assert.equal(ledger.outstandingRaw(), 800_000n);
  assert.equal(ledger.spentRaw, 0n);

  // Settling books the real fee.
  ledger.settle('r2', 150_000n);
  assert.equal(ledger.spentRaw, 150_000n);
  assert.equal(ledger.outstandingRaw(), 600_000n);
});
