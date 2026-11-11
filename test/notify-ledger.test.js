'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  upsertLedgerRetryItem,
  readLedgerRetryQueue,
  msUntilNextDueAll,
  isoFromMs,
  hasRedeliverRequestFiles,
  writeRedeliverRequest,
} = require('../src/notify-ledger.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snail-ledger-'));
}

test('ledger write failure lands in retry queue with backoff', () => {
  const mailDir = tempDir();
  const nowMs = 1_000_000;
  const { attempts, next } = upsertLedgerRetryItem(
    mailDir,
    {
      notify_id: 'work/1/10',
      account: 'work',
      uid: 10,
      uid_validity: 1,
      file: 'f.json',
      attempts: 0,
      last_status: 'none',
      next_attempt_at: isoFromMs(nowMs),
    },
    nowMs,
  );
  assert.equal(attempts, 1);
  assert.equal(next.last_status, 'ledger');
  assert.equal(readLedgerRetryQueue(mailDir).length, 1);
  const wait = msUntilNextDueAll([], readLedgerRetryQueue(mailDir), nowMs);
  assert.equal(wait, 1000);
});

test('redeliver poll sees request files only when present', () => {
  const mailDir = tempDir();
  assert.equal(hasRedeliverRequestFiles(mailDir), false);
  writeRedeliverRequest(mailDir, '20260101T120000Z_1_0000000001.json');
  assert.equal(hasRedeliverRequestFiles(mailDir), true);
});
