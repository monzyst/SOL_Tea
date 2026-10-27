/**
 * packages/journal — append-only signed outbox and evidence log.
 *
 * The write order is the whole point (V6 §07):
 *
 *   reserve -> record intent -> SIGN -> append SIGNED record -> submit
 *
 * If the process dies between SIGN and submit, the SIGNED record is on disk, so
 * startup recovery can reconcile a transaction that may well be on chain. A
 * signed-but-unjournaled transaction is unrecoverable, and an unjournaled
 * submission is an untraceable spend — both are designed out here.
 *
 * Records are JSON lines with a monotonically increasing sequence and a hash
 * chain over the previous record: tamper-evidence without extra infrastructure.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptState } from '../../domain/src';

export interface JournalRecord {
  readonly seq: number;
  readonly ts: string;
  readonly intentId: string;
  readonly routeKey: string;
  readonly state: AttemptState;
  readonly signature: string | null;
  readonly payload: Record<string, unknown>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface JournalAppendInput {
  readonly intentId: string;
  readonly routeKey: string;
  readonly state: AttemptState;
  readonly signature?: string | null;
  readonly payload?: Record<string, unknown>;
}

const GENESIS_HASH = '0'.repeat(64);

function hashRecord(record: Omit<JournalRecord, 'hash'>): string {
  const canonical = JSON.stringify({
    seq: record.seq,
    ts: record.ts,
    intentId: record.intentId,
    routeKey: record.routeKey,
    state: record.state,
    signature: record.signature,
    payload: record.payload,
    prevHash: record.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class JournalIntegrityError extends Error {
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(`journal integrity failure at seq ${seq}: ${message}`);
    this.name = 'JournalIntegrityError';
  }
}

export class SignedOutbox {
  private seq = 0;
  private lastHash = GENESIS_HASH;
  private readonly records: JournalRecord[] = [];

  constructor(
    private readonly filePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) this.replay();
    else writeFileSync(filePath, '');
  }

  get path(): string {
    return this.filePath;
  }

  /** Read the on-disk journal and fail loudly on any tampering or truncation. */
  private replay(): void {
    const lines = readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    for (const line of lines) {
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        throw new JournalIntegrityError(expectedSeq, 'line is not valid JSON');
      }
      if (record.seq !== expectedSeq) {
        throw new JournalIntegrityError(record.seq, `expected seq ${expectedSeq}`);
      }
      if (record.prevHash !== prevHash) {
        throw new JournalIntegrityError(record.seq, 'prevHash does not chain');
      }
      if (hashRecord(record) !== record.hash) {
        throw new JournalIntegrityError(record.seq, 'hash mismatch (record altered)');
      }
      this.records.push(record);
      prevHash = record.hash;
      expectedSeq += 1;
    }
    this.seq = expectedSeq - 1;
    this.lastHash = prevHash;
  }

  /**
   * Append durably. `appendFileSync` is deliberate: a submission must never
   * happen before its intent is on disk, so this path chooses durability over
   * throughput (a handful of writes per trade).
   */
  append(input: JournalAppendInput): JournalRecord {
    const base = {
      seq: this.seq + 1,
      ts: this.clock().toISOString(),
      intentId: input.intentId,
      routeKey: input.routeKey,
      state: input.state,
      signature: input.signature ?? null,
      payload: input.payload ?? {},
      prevHash: this.lastHash,
    };
    const record: JournalRecord = { ...base, hash: hashRecord(base) };
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    this.seq = record.seq;
    this.lastHash = record.hash;
    this.records.push(record);
    return record;
  }

  get size(): number {
    return this.records.length;
  }

  all(): readonly JournalRecord[] {
    return this.records;
  }

  forIntent(intentId: string): JournalRecord[] {
    return this.records.filter((record) => record.intentId === intentId);
  }

  /**
   * Intents that were SIGNED or SUBMITTED but never reached a terminal state.
   * Startup reconciliation must resolve these before new signing is allowed.
   */
  unresolved(): JournalRecord[] {
    const terminal = new Set<AttemptState>(['RECONCILED', 'REJECTED', 'FAILED']);
    const latest = new Map<string, JournalRecord>();
    for (const record of this.records) latest.set(record.intentId, record);
    return [...latest.values()].filter((record) => !terminal.has(record.state));
  }
}

export function journalPathFor(dir: string): string {
  return join(dir, 'signed-outbox.jsonl');
}
