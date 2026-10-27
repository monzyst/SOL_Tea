/**
 * packages/store — the durable state of record.
 *
 * Why this exists. The previous revision kept reservations in a `Map` and route
 * failures in a local variable. That is fine for one process and wrong for two:
 *
 *  - A restart forgot every outstanding fee reservation, so the period cap could
 *    be overrun simply by restarting during a burst.
 *  - Route-failure counters (audit T08) had no memory, so the "quarantine a route
 *    that keeps losing fees" control could never actually fire across restarts.
 *  - Nothing tied a reservation, an economic intent and an outbox entry together,
 *    so a crash between them left the books inconsistent (the Z2-03 finding).
 *
 * The fix is one transactional store. SQLite in WAL mode is chosen deliberately:
 * it is a real ACID engine with a single-writer model that matches this workload
 * (a handful of writes per trade), it needs no server, and it survives process
 * death. The schema below is plain SQL and ports to PostgreSQL by changing the
 * adapter, not the semantics.
 *
 * The journal file stays authoritative for the *signed artifact* (bytes + hash
 * chain); this store is authoritative for *state* (what is reserved, pending,
 * reconciled). An intent row and its reservation are committed in ONE
 * transaction, so either both exist or neither does.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type IntentState =
  | 'DISCOVERED'
  | 'QUOTED'
  | 'ADMITTED'
  | 'RESERVED'
  | 'SIGNED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'INCLUDED'
  | 'AWAITING_FINALITY'
  | 'FINALIZED'
  | 'RECONCILED'
  | 'REJECTED'
  | 'FAILED';

export interface IntentRow {
  readonly intentId: string;
  readonly routeKey: string;
  readonly economicKey: string;
  readonly state: IntentState;
  readonly principalRaw: string;
  readonly worstCaseFeeRaw: string;
  readonly actualFeeRaw: string | null;
  readonly signature: string | null;
  readonly messageSha256: string | null;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
  readonly note: string | null;
}

export interface ReservationRow {
  readonly reservationId: string;
  readonly intentId: string;
  readonly routeKey: string;
  readonly worstCaseFeeRaw: string;
  readonly actualFeeRaw: string | null;
  readonly state: 'RESERVED' | 'SETTLED' | 'EXPIRED';
  readonly periodStartUtc: string;
  readonly createdAtUtc: string;
  readonly closedAtUtc: string | null;
}

const SCHEMA_VERSION = 1;

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per economic attempt. \`economic_key\` is the deduplication identity:
-- two attempts that would trade the same route at the same size in the same
-- slot cannot both be legitimate, and a UNIQUE index makes that impossible
-- rather than merely unlikely.
CREATE TABLE IF NOT EXISTS intents (
  intent_id        TEXT PRIMARY KEY,
  route_key        TEXT NOT NULL,
  economic_key     TEXT NOT NULL,
  state            TEXT NOT NULL,
  principal_raw    TEXT NOT NULL,
  worst_case_fee   TEXT NOT NULL,
  actual_fee       TEXT,
  signature        TEXT,
  message_sha256   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  note             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS intents_economic_key ON intents(economic_key);
CREATE INDEX IF NOT EXISTS intents_state ON intents(state);
CREATE INDEX IF NOT EXISTS intents_route ON intents(route_key);

-- Fee reservations. Outstanding (RESERVED) rows count against the period cap;
-- only SETTLED rows consume it, with the ACTUAL fee.
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id   TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL,
  route_key        TEXT NOT NULL,
  worst_case_fee   TEXT NOT NULL,
  actual_fee       TEXT,
  state            TEXT NOT NULL,
  period_start     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  closed_at        TEXT
);
CREATE INDEX IF NOT EXISTS reservations_state ON reservations(state);
CREATE INDEX IF NOT EXISTS reservations_period ON reservations(period_start, state);

-- Outbox for anything that must leave the process exactly once (alerts,
-- settlement notices). Delivered rows keep their payload for audit.
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id        TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  delivered_at     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at, created_at);

-- Durable per-route health. This is what lets fee-loss control work across
-- restarts (audit T08).
CREATE TABLE IF NOT EXISTS route_health (
  route_key        TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_attempts   INTEGER NOT NULL DEFAULT 0,
  total_failures   INTEGER NOT NULL DEFAULT 0,
  last_failure_at  TEXT,
  quarantined_until TEXT,
  updated_at       TEXT NOT NULL
);

-- Realised results, keyed by signature so re-reconciling is idempotent.
CREATE TABLE IF NOT EXISTS settlements (
  signature        TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL,
  route_key        TEXT NOT NULL,
  verdict          TEXT NOT NULL,
  realised_delta   TEXT,
  fee_lamports     TEXT,
  slot             INTEGER,
  reconciled_at    TEXT NOT NULL,
  note             TEXT
);

-- Every state transition, append-only. Gives the operator a full trace of an
-- attempt without replaying the JSONL journal.
CREATE TABLE IF NOT EXISTS intent_events (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id        TEXT NOT NULL,
  state            TEXT NOT NULL,
  at_utc           TEXT NOT NULL,
  detail           TEXT
);
CREATE INDEX IF NOT EXISTS intent_events_intent ON intent_events(intent_id, seq);
`;

export class StoreError extends Error {
  constructor(
    readonly code: 'BUDGET_EXHAUSTED' | 'DUPLICATE_INTENT' | 'NOT_FOUND' | 'SCHEMA' | 'INVALID_STATE',
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Stable identity for an economic attempt, used for deduplication. */
export function economicKey(input: {
  routeKey: string;
  principalRaw: bigint;
  observedSlot: number;
}): string {
  const canonical = `${input.routeKey}|${input.principalRaw.toString()}|${input.observedSlot}`;
  return createHash('sha256').update(canonical).digest('hex');
}

export interface StoreOptions {
  /** Path to the database file, or ':memory:' for tests. */
  readonly path: string;
  /** Milliseconds to wait for a writer before failing. */
  readonly busyTimeoutMs?: number;
}

export class Store {
  private readonly db: Database.Database;

  constructor(private readonly options: StoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    // WAL: readers never block the single writer, which is what keeps the hot
    // path from stalling behind a reconciliation sweep.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // Check for the TABLE first. The previous revision did
    // `SELECT value FROM sqlite_master ...`, which cannot work: sqlite_master has
    // no `value` column, so opening any database — including a brand new one —
    // threw SQLITE_ERROR. The store was therefore unopenable, and no test noticed
    // because nothing exercised openStore().
    const metaTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get() as { name: string } | undefined;

    if (metaTable) {
      const version = this.db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string } | undefined;
      if (version && Number(version.value) > SCHEMA_VERSION) {
        throw new StoreError(
          'SCHEMA',
          `database schema ${version.value} is newer than this build (${SCHEMA_VERSION})`,
        );
      }
    }
    this.db.exec(MIGRATION_V1);
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(SCHEMA_VERSION));
  }

  /** Run `fn` inside one IMMEDIATE transaction; any throw rolls everything back. */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped.immediate();
  }

  /* ------------------------------------------------------------- intents */

  insertIntentWithReservation(input: {
    intentId: string;
    routeKey: string;
    economicKey: string;
    principalRaw: bigint;
    worstCaseFeeRaw: bigint;
    reservationId: string;
    periodStartUtc: string;
    periodCapRaw: bigint;
    nowUtc: Date;
  }): void {
    const now = input.nowUtc.toISOString();
    this.transaction(() => {
      // Budget check happens INSIDE the transaction, so two concurrent
      // reservers cannot both read the same headroom and both proceed.
      const used = this.periodUsedRaw(input.periodStartUtc);
      if (used + input.worstCaseFeeRaw > input.periodCapRaw) {
        throw new StoreError(
          'BUDGET_EXHAUSTED',
          `fee budget exhausted: used ${used} + ${input.worstCaseFeeRaw} > cap ${input.periodCapRaw}`,
        );
      }
      const duplicate = this.db
        .prepare('SELECT intent_id FROM intents WHERE economic_key = ?')
        .get(input.economicKey) as { intent_id: string } | undefined;
      if (duplicate) {
        throw new StoreError(
          'DUPLICATE_INTENT',
          `economic intent already recorded as ${duplicate.intent_id}`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO intents(intent_id, route_key, economic_key, state, principal_raw,
             worst_case_fee, actual_fee, signature, message_sha256, created_at, updated_at, note)
           VALUES(?, ?, ?, 'RESERVED', ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          input.intentId,
          input.routeKey,
          input.economicKey,
          input.principalRaw.toString(),
          input.worstCaseFeeRaw.toString(),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO reservations(reservation_id, intent_id, route_key, worst_case_fee,
             actual_fee, state, period_start, created_at, closed_at)
           VALUES(?, ?, ?, ?, NULL, 'RESERVED', ?, ?, NULL)`,
        )
        .run(
          input.reservationId,
          input.intentId,
          input.routeKey,
          input.worstCaseFeeRaw.toString(),
          input.periodStartUtc,
          now,
        );
      this.appendEvent(input.intentId, 'RESERVED', now, { reservationId: input.reservationId });
    });
  }

  /** Actual committed spend in a period: settled fees + still-outstanding reserves. */
  periodUsedRaw(periodStartUtc: string): bigint {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state='SETTLED' THEN CAST(actual_fee AS INTEGER) ELSE 0 END), 0) AS spent,
           COALESCE(SUM(CASE WHEN state='RESERVED' THEN CAST(worst_case_fee AS INTEGER) ELSE 0 END), 0) AS outstanding
         FROM reservations WHERE period_start = ?`,
      )
      .get(periodStartUtc) as { spent: number; outstanding: number };
    return BigInt(row.spent) + BigInt(row.outstanding);
  }

  periodSpentRaw(periodStartUtc: string): bigint {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CAST(actual_fee AS INTEGER)), 0) AS spent
         FROM reservations WHERE period_start = ? AND state='SETTLED'`,
      )
      .get(periodStartUtc) as { spent: number };
    return BigInt(row.spent);
  }

  outstandingReservations(): ReservationRow[] {
    return this.db
      .prepare("SELECT * FROM reservations WHERE state='RESERVED' ORDER BY created_at")
      .all()
      .map((row) => mapReservation(row as Record<string, unknown>));
  }

  getIntent(intentId: string): IntentRow | null {
    const row = this.db.prepare('SELECT * FROM intents WHERE intent_id = ?').get(intentId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapIntent(row) : null;
  }

  setIntentState(input: {
    intentId: string;
    state: IntentState;
    nowUtc: Date;
    signature?: string | null;
    messageSha256?: string | null;
    note?: string | null;
  }): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT state FROM intents WHERE intent_id = ?').get(input.intentId) as
        | { state: string }
        | undefined;
      if (!existing) throw new StoreError('NOT_FOUND', `unknown intent ${input.intentId}`);
      this.db
        .prepare(
          `UPDATE intents SET state=?, updated_at=?,
             signature=COALESCE(?, signature),
             message_sha256=COALESCE(?, message_sha256),
             note=COALESCE(?, note)
           WHERE intent_id=?`,
        )
        .run(
          input.state,
          input.nowUtc.toISOString(),
          input.signature ?? null,
          input.messageSha256 ?? null,
          input.note ?? null,
          input.intentId,
        );
      this.appendEvent(input.intentId, input.state, input.nowUtc.toISOString(), {
        note: input.note ?? null,
      });
    });
  }

  settleReservation(input: {
    reservationId: string;
    actualFeeRaw: bigint;
    nowUtc: Date;
    intentState: IntentState;
  }): void {
    const now = input.nowUtc.toISOString();
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM reservations WHERE reservation_id = ?')
        .get(input.reservationId) as Record<string, unknown> | undefined;
      if (!row) throw new StoreError('NOT_FOUND', `unknown reservation ${input.reservationId}`);
      const reservation = mapReservation(row);
      if (reservation.state !== 'RESERVED') {
        throw new StoreError(
          'INVALID_STATE',
          `reservation ${input.reservationId} is already ${reservation.state}`,
        );
      }
      if (input.actualFeeRaw < 0n) throw new StoreError('INVALID_STATE', 'actual fee cannot be negative');
      this.db
        .prepare("UPDATE reservations SET state='SETTLED', actual_fee=?, closed_at=? WHERE reservation_id=?")
        .run(input.actualFeeRaw.toString(), now, input.reservationId);
      this.db
        .prepare('UPDATE intents SET state=?, actual_fee=?, updated_at=? WHERE intent_id=?')
        .run(input.intentState, input.actualFeeRaw.toString(), now, reservation.intentId);
      this.appendEvent(reservation.intentId, input.intentState, now, {
        actualFeeRaw: input.actualFeeRaw.toString(),
      });
    });
  }

  expireReservation(reservationId: string, nowUtc: Date, reason: string): void {
    const now = nowUtc.toISOString();
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM reservations WHERE reservation_id = ?')
        .get(reservationId) as Record<string, unknown> | undefined;
      if (!row) throw new StoreError('NOT_FOUND', `unknown reservation ${reservationId}`);
      const reservation = mapReservation(row);
      if (reservation.state !== 'RESERVED') return;
      this.db
        .prepare("UPDATE reservations SET state='EXPIRED', closed_at=? WHERE reservation_id=?")
        .run(now, reservationId);
      this.appendEvent(reservation.intentId, 'REJECTED', now, { reason, reservationId });
    });
  }

  /** Intents that may still be live on chain. Startup recovery starts here. */
  unresolvedIntents(): IntentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM intents
         WHERE state IN ('SIGNED','SUBMITTING','SUBMITTED','INCLUDED','AWAITING_FINALITY')
         ORDER BY created_at`,
      )
      .all()
      .map((row) => mapIntent(row as Record<string, unknown>));
  }

  eventsFor(intentId: string): Array<{ seq: number; state: string; atUtc: string; detail: unknown }> {
    return (
      this.db
        .prepare('SELECT seq, state, at_utc, detail FROM intent_events WHERE intent_id = ? ORDER BY seq')
        .all(intentId) as Array<{ seq: number; state: string; at_utc: string; detail: string | null }>
    ).map((row) => ({
      seq: row.seq,
      state: row.state,
      atUtc: row.at_utc,
      detail: row.detail ? JSON.parse(row.detail) : null,
    }));
  }

  private appendEvent(intentId: string, state: string, atUtc: string, detail: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO intent_events(intent_id, state, at_utc, detail) VALUES(?, ?, ?, ?)')
      .run(intentId, state, atUtc, JSON.stringify(detail));
  }

  /* --------------------------------------------------------- route health */

  /** Record an outcome and return the updated health row. */
  recordRouteOutcome(input: {
    routeKey: string;
    outcome: 'SUCCESS' | 'REVERTED' | 'UNKNOWN' | 'FAILED';
    nowUtc: Date;
    quarantineAfter: number;
    quarantineMs: number;
  }): { consecutiveFailures: number; quarantinedUntil: string | null } {
    const now = input.nowUtc.toISOString();
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM route_health WHERE route_key = ?')
        .get(input.routeKey) as Record<string, unknown> | undefined;

      const priorFailures = existing ? Number(existing['consecutive_failures']) : 0;
      const priorTotal = existing ? Number(existing['total_attempts']) : 0;
      const priorFailed = existing ? Number(existing['total_failures']) : 0;
      const priorQuarantine = existing ? (existing['quarantined_until'] as string | null) : null;

      // A REVERTED transaction still cost its fee, so it counts as a failure for
      // quarantine purposes — the point of this counter is fee preservation.
      const isFailure = input.outcome !== 'SUCCESS';
      const consecutive = isFailure ? priorFailures + 1 : 0;
      let quarantinedUntil = priorQuarantine;
      if (isFailure && consecutive >= input.quarantineAfter) {
        quarantinedUntil = new Date(input.nowUtc.getTime() + input.quarantineMs).toISOString();
      }

      this.db
        .prepare(
          `INSERT INTO route_health(route_key, consecutive_failures, total_attempts, total_failures,
             last_failure_at, quarantined_until, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(route_key) DO UPDATE SET
             consecutive_failures=excluded.consecutive_failures,
             total_attempts=excluded.total_attempts,
             total_failures=excluded.total_failures,
             last_failure_at=COALESCE(excluded.last_failure_at, route_health.last_failure_at),
             quarantined_until=excluded.quarantined_until,
             updated_at=excluded.updated_at`,
        )
        .run(
          input.routeKey,
          consecutive,
          priorTotal + 1,
          isFailure ? priorFailed + 1 : priorFailed,
          isFailure ? now : null,
          quarantinedUntil,
          now,
        );

      return { consecutiveFailures: consecutive, quarantinedUntil };
    });
  }

  routeHealth(routeKey: string): {
    consecutiveFailures: number;
    lastFailureAtUtc: string | null;
    quarantinedUntil: string | null;
    totalAttempts: number;
    totalFailures: number;
  } {
    const row = this.db.prepare('SELECT * FROM route_health WHERE route_key = ?').get(routeKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return {
        consecutiveFailures: 0,
        lastFailureAtUtc: null,
        quarantinedUntil: null,
        totalAttempts: 0,
        totalFailures: 0,
      };
    }
    return {
      consecutiveFailures: Number(row['consecutive_failures']),
      lastFailureAtUtc: (row['last_failure_at'] as string | null) ?? null,
      quarantinedUntil: (row['quarantined_until'] as string | null) ?? null,
      totalAttempts: Number(row['total_attempts']),
      totalFailures: Number(row['total_failures']),
    };
  }

  /* ----------------------------------------------------------- settlements */

  /** Idempotent: re-reconciling the same signature does not double-count. */
  recordSettlement(input: {
    signature: string;
    intentId: string;
    routeKey: string;
    verdict: string;
    realisedDeltaRaw: bigint | null;
    feeLamports: bigint | null;
    slot: number | null;
    nowUtc: Date;
    note?: string | null;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO settlements(signature, intent_id, route_key, verdict, realised_delta,
           fee_lamports, slot, reconciled_at, note)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signature) DO NOTHING`,
      )
      .run(
        input.signature,
        input.intentId,
        input.routeKey,
        input.verdict,
        input.realisedDeltaRaw?.toString() ?? null,
        input.feeLamports?.toString() ?? null,
        input.slot,
        input.nowUtc.toISOString(),
        input.note ?? null,
      );
    return result.changes > 0;
  }

  totals(): {
    attempts: number;
    reconciled: number;
    netPositive: number;
    realisedDeltaRaw: bigint;
    feesLamports: bigint;
  } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM intents) AS attempts,
           (SELECT COUNT(*) FROM settlements) AS reconciled,
           (SELECT COUNT(*) FROM settlements WHERE verdict='PROVEN_NET_POSITIVE') AS netPositive,
           (SELECT COALESCE(SUM(CAST(realised_delta AS INTEGER)), 0) FROM settlements) AS delta,
           (SELECT COALESCE(SUM(CAST(fee_lamports AS INTEGER)), 0) FROM settlements) AS fees`,
      )
      .get() as { attempts: number; reconciled: number; netPositive: number; delta: number; fees: number };
    return {
      attempts: row.attempts,
      reconciled: row.reconciled,
      netPositive: row.netPositive,
      realisedDeltaRaw: BigInt(row.delta),
      feesLamports: BigInt(row.fees),
    };
  }

  /* --------------------------------------------------------------- outbox */

  enqueue(input: { topic: string; payload: Record<string, unknown>; nowUtc: Date }): string {
    const id = createHash('sha256')
      .update(`${input.topic}|${JSON.stringify(input.payload)}|${input.nowUtc.toISOString()}`)
      .digest('hex')
      .slice(0, 32);
    this.db
      .prepare(
        `INSERT INTO outbox(outbox_id, topic, payload, created_at, delivered_at, attempts, last_error)
         VALUES(?, ?, ?, ?, NULL, 0, NULL)
         ON CONFLICT(outbox_id) DO NOTHING`,
      )
      .run(id, input.topic, JSON.stringify(input.payload), input.nowUtc.toISOString());
    return id;
  }

  pendingOutbox(limit = 50): Array<{ outboxId: string; topic: string; payload: Record<string, unknown> }> {
    return (
      this.db
        .prepare(
          `SELECT outbox_id, topic, payload FROM outbox
           WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?`,
        )
        .all(limit) as Array<{ outbox_id: string; topic: string; payload: string }>
    ).map((row) => ({
      outboxId: row.outbox_id,
      topic: row.topic,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  markDelivered(outboxId: string, nowUtc: Date, error?: string | null): void {
    if (error) {
      this.db
        .prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE outbox_id = ?')
        .run(error, outboxId);
      return;
    }
    this.db
      .prepare('UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE outbox_id = ?')
      .run(nowUtc.toISOString(), outboxId);
  }
}

function mapIntent(row: Record<string, unknown>): IntentRow {
  return {
    intentId: String(row['intent_id']),
    routeKey: String(row['route_key']),
    economicKey: String(row['economic_key']),
    state: String(row['state']) as IntentState,
    principalRaw: String(row['principal_raw']),
    worstCaseFeeRaw: String(row['worst_case_fee']),
    actualFeeRaw: (row['actual_fee'] as string | null) ?? null,
    signature: (row['signature'] as string | null) ?? null,
    messageSha256: (row['message_sha256'] as string | null) ?? null,
    createdAtUtc: String(row['created_at']),
    updatedAtUtc: String(row['updated_at']),
    note: (row['note'] as string | null) ?? null,
  };
}

function mapReservation(row: Record<string, unknown>): ReservationRow {
  return {
    reservationId: String(row['reservation_id']),
    intentId: String(row['intent_id']),
    routeKey: String(row['route_key']),
    worstCaseFeeRaw: String(row['worst_case_fee']),
    actualFeeRaw: (row['actual_fee'] as string | null) ?? null,
    state: String(row['state']) as ReservationRow['state'],
    periodStartUtc: String(row['period_start']),
    createdAtUtc: String(row['created_at']),
    closedAtUtc: (row['closed_at'] as string | null) ?? null,
  };
}

export function openStore(path: string): Store {
  return new Store({ path });
}
