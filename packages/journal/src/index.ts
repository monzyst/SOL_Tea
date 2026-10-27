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
 * Durability: every append is `write(2)` + `fsync(2)` on the file descriptor
 * before returning. `appendFileSync` alone does NOT flush to stable storage: the
 * data can sit in the page cache and vanish with the process, which would let a
 * submission happen whose intent was never persisted. fsync is the difference
 * between "we wrote it" and "it survived".
 *
 * Recoverability (audit T04): the ADMITTED record carries the FULL message bytes
 * (base64) plus their SHA-256 digest, and the SIGNED record carries the complete
 * signed wire transaction. A 16-character prefix is not an artifact — it cannot
 * be re-signed, re-submitted or byte-compared. Full retention is what makes
 * crash recovery possible at all.
 *
 * Records are JSON lines with a monotonically increasing sequence and a hash
 * chain over the previous record: tamper-evidence without extra infrastructure.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
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

/** SHA-256 of raw message bytes — the digest the signer must agree with. */
export function messageDigest(messageBytes: Uint8Array): string {
  return createHash('sha256').update(messageBytes).digest('hex');
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

export class JournalWriteError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
  ) {
    super(`journal append failed (${filePath}): ${message}`);
    this.name = 'JournalWriteError';
  }
}

export interface JournalRecovery {
  /** Intents whose last record is SIGNED: signed, possibly never submitted. */
  readonly signedNotSubmitted: readonly JournalRecord[];
  /** Intents whose last record is SUBMITTED: outcome unknown to this process. */
  readonly submittedUnresolved: readonly JournalRecord[];
  /** Intents whose last record is AWAITING_FINALITY. */
  readonly awaitingFinality: readonly JournalRecord[];
}

export class SignedOutbox {
  private seq = 0;
  private lastHash = GENESIS_HASH;
  private readonly records: JournalRecord[] = [];

  constructor(
    private readonly filePath: string,
    private readonly clock: () => Date = () => new Date(),
    /** Set false only in tests that assert on partial writes. */
    private readonly fsyncOnAppend = true,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) this.replay();
    else this.createEmpty();
  }

  get path(): string {
    return this.filePath;
  }

  get tip(): string {
    return this.lastHash;
  }

  private createEmpty(): void {
    const fd = openSync(this.filePath, 'a');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
        // A torn tail is possible after a hard power loss. It is reported, not
        // silently dropped: an unreadable last line means the last attempt's
        // evidence is gone and must be re-derived from chain state.
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
   * Append durably: one write, one fsync, then the in-memory index advances.
   *
   * Ordering matters. If the write or fsync fails the in-memory state is NOT
   * advanced, so the next append reuses the same seq/hash and the on-disk chain
   * stays consistent. The caller must treat a throw as "this attempt must not
   * continue" — nothing may be submitted whose intent is not on stable storage.
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
    const line = JSON.stringify(record) + '\n';

    let fd: number | null = null;
    try {
      fd = openSync(this.filePath, 'a');
      writeSync(fd, line, null, 'utf8');
      if (this.fsyncOnAppend) fsyncSync(fd);
    } catch (error) {
      throw new JournalWriteError(this.filePath, (error as Error).message);
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* close failure must not mask a successful append */
        }
      }
    }

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

  /** Last record for an intent, or undefined when it was never journaled. */
  latest(intentId: string): JournalRecord | undefined {
    const records = this.forIntent(intentId);
    return records[records.length - 1];
  }

  /**
   * The complete signed wire transaction recorded for an intent, base64.
   *
   * This is the recoverable artifact: with it, recovery can re-submit or compare
   * bytes without the original process. Absent means the intent never reached
   * signing, which is a different (and safer) state.
   */
  signedTransactionBase64(intentId: string): string | null {
    for (const record of this.forIntent(intentId)) {
      if (record.state !== 'SIGNED') continue;
      const artifact = record.payload['signedTransactionBase64'];
      if (typeof artifact === 'string' && artifact.length > 0) return artifact;
    }
    return null;
  }

  /** Digest recorded before signing, to compare against a recovered artifact. */
  expectedMessageDigest(intentId: string): string | null {
    for (const record of this.forIntent(intentId)) {
      if (record.state !== 'ADMITTED') continue;
      const digest = record.payload['messageSha256'];
      if (typeof digest === 'string' && digest.length === 64) return digest;
    }
    return null;
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

  /**
   * Split unresolved intents by the exact phase they were in. Recovery treats
   * these differently: SIGNED-not-submitted may be safely re-attempted or
   * abandoned, SUBMITTED must be resolved against chain state, and
   * AWAITING_FINALITY needs a decision on provisional inclusion.
   */
  recovery(): JournalRecovery {
    const pending = this.unresolved();
    return {
      signedNotSubmitted: pending.filter((r) => r.state === 'SIGNED'),
      submittedUnresolved: pending.filter((r) => r.state === 'SUBMITTED'),
      awaitingFinality: pending.filter((r) => r.state === 'AWAITING_FINALITY'),
    };
  }
}

export function journalPathFor(dir: string): string {
  return join(dir, 'signed-outbox.jsonl');
}
