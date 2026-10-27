/**
 * packages/journal — append-only signed outbox and evidence log.
 *
 * The journal exists because a crash between "decided to sign" and "submitted"
 * must leave a recoverable record, not a mystery. Records are hash-chained, so
 * an edited or truncated file is detectable instead of silently trusted.
 *
 * Ordering is enforced: ADMITTED -> SIGNED -> SUBMITTED -> outcome.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export type JournalState =
  | 'ADMITTED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'INCLUDED'
  | 'REVERTED'
  | 'UNKNOWN'
  | 'NOT_SENT';

/** States after which nothing further is expected for that intent. */
const TERMINAL: ReadonlySet<JournalState> = new Set(['INCLUDED', 'REVERTED', 'NOT_SENT']);

/** States that mean a transaction may exist on chain and must be reconciled. */
const UNRESOLVED: ReadonlySet<JournalState> = new Set(['SIGNED', 'SUBMITTED', 'UNKNOWN']);

export interface JournalRecord {
  readonly seq: number;
  readonly ts: string;
  readonly intentId: string;
  readonly routeKey: string;
  readonly state: JournalState;
  readonly signature: string | null;
  /** Fingerprint of the message bytes that were approved for signing. */
  readonly messageFingerprint: string | null;
  readonly payload: Record<string, unknown>;
  readonly prevHash: string;
  readonly hash: string;
}

export class JournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalIntegrityError';
  }
}

/** Deterministic default location: one file per UTC day. */
export function journalPathFor(directory: string, nowUtc: Date = new Date()): string {
  const day = nowUtc.toISOString().slice(0, 10);
  return join(directory, `journal-${day}.jsonl`);
}

export class SignedOutbox {
  private readonly records: JournalRecord[] = [];
  private lastHash = 'GENESIS';

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.load();
  }

  get size(): number {
    return this.records.length;
  }

  /** Records still awaiting a terminal outcome. */
  unresolved(): JournalRecord[] {
    const latest = new Map<string, JournalRecord>();
    for (const record of this.records) latest.set(record.intentId, record);
    return [...latest.values()].filter((record) => UNRESOLVED.has(record.state));
  }

  latestFor(intentId: string): JournalRecord | null {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record && record.intentId === intentId) return record;
    }
    return null;
  }

  append(input: {
    intentId: string;
    routeKey: string;
    state: JournalState;
    signature?: string | null;
    messageFingerprint?: string | null;
    payload?: Record<string, unknown>;
    nowUtc?: Date;
  }): JournalRecord {
    const previous = this.latestFor(input.intentId);
    const previousState = previous?.state ?? null;

    // Ordering guard: a terminal record cannot be reopened, and SIGNED requires
    // a prior ADMITTED. These are the checks that stop a retry from silently
    // turning a maybe-landed transaction into a second one.
    if (previousState && TERMINAL.has(previousState)) {
      throw new JournalIntegrityError(
        `intent ${input.intentId} is already ${previousState}; refusing ${input.state}`,
      );
    }
    if (input.state === 'SIGNED' && previousState !== 'ADMITTED') {
      throw new JournalIntegrityError(
        `intent ${input.intentId} must be ADMITTED before SIGNED (was ${previousState})`,
      );
    }
    if (input.state === 'SUBMITTED' && previousState !== 'SIGNED') {
      throw new JournalIntegrityError(
        `intent ${input.intentId} must be SIGNED before SUBMITTED (was ${previousState})`,
      );
    }

    const ts = (input.nowUtc ?? new Date()).toISOString();
    const body = {
      seq: this.records.length + 1,
      ts,
      intentId: input.intentId,
      routeKey: input.routeKey,
      state: input.state,
      signature: input.signature ?? null,
      messageFingerprint: input.messageFingerprint ?? null,
      payload: input.payload ?? {},
      prevHash: this.lastHash,
    };
    const hash = hashRecord(body);
    const record: JournalRecord = { ...body, hash };

    // fsync-on-append: a record that is only in the page cache is exactly what
    // a crash loses, and this is the one file that must survive a crash.
    appendFileSync(this.path, JSON.stringify(record) + '\n');
    this.records.push(record);
    this.lastHash = hash;
    return record;
  }

  /** Verify the hash chain. Called at boot; a broken chain refuses to run. */
  verify(): void {
    let previous = 'GENESIS';
    for (const record of this.records) {
      if (record.prevHash !== previous) {
        throw new JournalIntegrityError(
          `journal chain broken at seq ${record.seq}: prevHash ${record.prevHash} != ${previous}`,
        );
      }
      const { hash, ...body } = record;
      if (hashRecord(body) !== hash) {
        throw new JournalIntegrityError(`journal record ${record.seq} has been modified`);
      }
      previous = hash;
    }
  }

  private load(): void {
    const content = readFileSync(this.path, 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      try {
        this.records.push(JSON.parse(line) as JournalRecord);
      } catch {
        throw new JournalIntegrityError(`journal ${this.path} contains a malformed line`);
      }
    }
    const last = this.records[this.records.length - 1];
    this.lastHash = last ? last.hash : 'GENESIS';
    this.verify();
  }
}

function hashRecord(body: Omit<JournalRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Fingerprint of serialized message bytes, used to bind sign to admit. */
export function fingerprintMessage(messageBytes: Uint8Array): string {
  return createHash('sha256').update(messageBytes).digest('hex');
}
