/**
 * packages/store — durability and atomicity tests.
 *
 * The store is the exposure cap's memory. If the reservation and the intent are
 * not written in the SAME transaction, a crash between them either (a) records an
 * intent with no reservation, which lets the cap be exceeded, or (b) leaves a
 * reservation with no intent, which permanently consumes budget. Both are silent,
 * so they are pinned here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../../packages/store/src';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const PERIOD = '2026-10-27T00:00:00.000Z';

function freshStore() {
  return openStore(':memory:');
}

function reserve(
  store: ReturnType<typeof freshStore>,
  input: { intentId: string; fee?: bigint; routeKey?: string; economicKey?: string },
) {
  return store.insertIntentWithReservation({
    intentId: input.intentId,
    routeKey: input.routeKey ?? 'orca:poolA>orca:poolB',
    economicKey: input.economicKey ?? `econ-${input.intentId}`,
    reservationId: `resv-${input.intentId}`,
    principalRaw: 1_000_000n,
    worstCaseFeeRaw: input.fee ?? 5_000n,
    // Generous cap: these tests are about atomicity, not budget exhaustion.
    periodCapRaw: 1_000_000_000n,
    periodStartUtc: PERIOD,
    nowUtc: NOW,
  });
}

test('intent and reservation are written together', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1' });

  assert.equal(store.outstandingReservations().length, 1);
  assert.equal(store.getIntent('i1')?.state, 'RESERVED');
  store.close();
});

test('budget consumed reflects only outstanding reservations', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1', fee: 4_000n });
  reserve(store, { intentId: 'i2', fee: 6_000n });

  assert.equal(store.periodUsedRaw(PERIOD), 10_000n);

  // Settling converts the reservation from worst-case ESTIMATE to ACTUAL spend.
  // It does not release budget: the fee was really paid, so the cap must keep
  // counting it — at the true amount, which is the whole point of the estimate.
  store.settleReservation({
    reservationId: 'resv-i1',
    actualFeeRaw: 3_500n,
    nowUtc: NOW,
    intentState: 'RECONCILED',
  });
  assert.equal(store.periodUsedRaw(PERIOD), 9_500n, 'budget drops to the actual fee, not to zero');
  assert.equal(store.periodSpentRaw(PERIOD), 3_500n, 'spend is the ACTUAL fee, not the estimate');
  store.close();
});

test('expiring a reservation releases its budget', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1', fee: 5_000n });
  store.expireReservation('resv-i1', NOW, 'quote decayed');
  assert.equal(store.periodUsedRaw(PERIOD), 0n);
  assert.equal(store.outstandingReservations().length, 0);
  store.close();
});

test('a duplicate economic key is refused, so the same edge cannot be reserved twice', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1', economicKey: 'same-edge' });
  // The store refuses a replay of the same economic intent with its own typed
  // error rather than a raw SQLite constraint failure.
  assert.throws(() => reserve(store, { intentId: 'i2', economicKey: 'same-edge' }), /already recorded/);
  // The failed insert must leave no half-written row behind.
  assert.equal(store.getIntent('i2'), null, 'a refused reservation writes no intent');
  store.close();
});

test('settling the same signature twice does not double-count', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1', fee: 5_000n });

  const first = store.recordSettlement({
    signature: 'sig-abc',
    intentId: 'i1',
    routeKey: 'r1',
    verdict: 'PROVEN_NET_POSITIVE',
    realisedDeltaRaw: 10_000n,
    feeLamports: 4_000n,
    slot: 1,
    nowUtc: NOW,
  });
  const second = store.recordSettlement({
    signature: 'sig-abc',
    intentId: 'i1',
    routeKey: 'r1',
    verdict: 'PROVEN_NET_POSITIVE',
    realisedDeltaRaw: 10_000n,
    feeLamports: 4_000n,
    slot: 1,
    nowUtc: NOW,
  });

  assert.equal(first, true, 'the first insert wins');
  assert.equal(second, false, 'the replay is recognised as a duplicate');
  assert.equal(store.totals().reconciled, 1);
  assert.equal(store.totals().realisedDeltaRaw, 10_000n, 'P&L is counted once');
  store.close();
});

test('unresolved intents are exactly the ones that may still be live on chain', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1' });
  reserve(store, { intentId: 'i2' });
  reserve(store, { intentId: 'i3' });
  reserve(store, { intentId: 'i4' });

  store.setIntentState({ intentId: 'i2', state: 'SUBMITTED', nowUtc: NOW, signature: 'sig-2' });
  // Closing an attempt releases its reservation — through the reservation API,
  // which is the only path that settles budget. setIntentState alone does NOT
  // release it, deliberately: the two records are independent so a crash between
  // them over-counts exposure rather than under-counting it.
  store.settleReservation({
    reservationId: 'resv-i3',
    actualFeeRaw: 5_000n,
    nowUtc: NOW,
    intentState: 'RECONCILED',
  });
  store.expireReservation('resv-i4', NOW, 'quote decayed');
  // i1 stays RESERVED: signed nothing yet, so there is nothing on chain to look
  // for. It is excluded from reconciliation, which is correct — a reservation
  // with no signature cannot be settled by asking the chain about it.

  const unresolved = store.unresolvedIntents().map((intent) => intent.intentId);
  assert.deepEqual(unresolved, ['i2'], 'only signature-bearing live states are reconcilable');

  // The reserved-but-unsigned intent is still tracked as outstanding exposure;
  // the settled one is not (it became actual spend instead).
  assert.deepEqual(
    store.outstandingReservations().map((reservation) => reservation.intentId).sort(),
    ['i1', 'i2'],
    'a RESERVED-but-unsigned attempt and a SUBMITTED one both hold budget',
  );
  store.close();
});

test('state transitions are recorded as an ordered trail', () => {
  const store = freshStore();
  reserve(store, { intentId: 'i1' });
  store.setIntentState({ intentId: 'i1', state: 'SUBMITTED', nowUtc: NOW, signature: 'sig-1' });
  store.setIntentState({ intentId: 'i1', state: 'INCLUDED', nowUtc: NOW });

  const events = store.eventsFor('i1').map((event) => event.state);
  assert.deepEqual(events, ['RESERVED', 'SUBMITTED', 'INCLUDED']);
  store.close();
});

test('route quarantine triggers after the configured number of failures', () => {
  const store = freshStore();
  const outcome = { outcome: 'REVERTED' as const, nowUtc: NOW, quarantineAfter: 3, quarantineMs: 60_000 };

  const first = store.recordRouteOutcome({ routeKey: 'r1', ...outcome });
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.quarantinedUntil, null, 'one failure is not a quarantine');

  store.recordRouteOutcome({ routeKey: 'r1', ...outcome });
  const third = store.recordRouteOutcome({ routeKey: 'r1', ...outcome });
  assert.equal(third.consecutiveFailures, 3);
  assert.notEqual(third.quarantinedUntil, null, 'third consecutive failure quarantines');

  // A success clears the streak but the quarantine already set stays until expiry.
  const recovered = store.recordRouteOutcome({ routeKey: 'r1', outcome: 'SUCCESS', nowUtc: NOW, quarantineAfter: 3, quarantineMs: 60_000 });
  assert.equal(recovered.consecutiveFailures, 0);
  store.close();
});

test('state survives a close/reopen cycle (WAL durability)', () => {
  const path = `/tmp/sol-tea-store-test-${process.pid}-${Date.now()}.db`;
  const first = openStore(path);
  reserve(first, { intentId: 'durable-1', fee: 7_000n });
  first.close();

  const second = openStore(path);
  assert.equal(second.getIntent('durable-1')?.state, 'RESERVED', 'the reservation outlived the process');
  assert.equal(second.periodUsedRaw(PERIOD), 7_000n);
  second.close();

  // Clean up the test artefacts.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').unlinkSync(`${path}${suffix}`);
    } catch {
      /* already gone */
    }
  }
});

test('an unknown intent cannot be transitioned', () => {
  const store = freshStore();
  assert.throws(
    () => store.setIntentState({ intentId: 'ghost', state: 'SIGNED', nowUtc: NOW }),
    /unknown intent/,
  );
  store.close();
});
