/**
 * Signed-outbox durability and tamper-evidence.
 *
 * The property that matters operationally: after a crash, a journal replayed
 * from disk must surface every intent that might have reached the chain, and it
 * must refuse to trust a file edited by hand.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalIntegrityError, SignedOutbox } from '../../packages/journal/src';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'sol-tea-journal-'));
}

test('records chain by hash and survive a restart', () => {
  const path = join(freshDir(), 'outbox.jsonl');
  const first = new SignedOutbox(path);

  first.append({ intentId: 'i1', routeKey: 'r1', state: 'ADMITTED' });
  first.append({ intentId: 'i1', routeKey: 'r1', state: 'SIGNED', signature: 'sig-1' });
  first.append({ intentId: 'i1', routeKey: 'r1', state: 'SUBMITTED', signature: 'sig-1' });

  assert.equal(first.size, 3);
  assert.equal(first.unresolved().length, 1, 'a submitted-but-unreconciled intent stays open');

  // Reopen: replay verifies the chain and restores the sequence.
  const reopened = new SignedOutbox(path);
  assert.equal(reopened.size, 3);
  assert.equal(reopened.unresolved()[0]?.signature, 'sig-1');

  reopened.append({ intentId: 'i1', routeKey: 'r1', state: 'RECONCILED', signature: 'sig-1' });
  assert.equal(reopened.unresolved().length, 0);
  assert.equal(reopened.all()[3]?.seq, 4);
});

test('a hand-edited record is rejected on replay', () => {
  const path = join(freshDir(), 'outbox.jsonl');
  const journal = new SignedOutbox(path);
  journal.append({ intentId: 'i1', routeKey: 'r1', state: 'SIGNED', signature: 'sig-1' });

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0] as string);
  tampered.state = 'RECONCILED'; // pretend it settled
  writeFileSync(path, JSON.stringify(tampered) + '\n');

  assert.throws(() => new SignedOutbox(path), JournalIntegrityError);
});

test('appending a malformed line is detected', () => {
  const path = join(freshDir(), 'outbox.jsonl');
  const journal = new SignedOutbox(path);
  journal.append({ intentId: 'i1', routeKey: 'r1', state: 'ADMITTED' });
  appendFileSync(path, 'not-json\n');
  assert.throws(() => new SignedOutbox(path), JournalIntegrityError);
});
