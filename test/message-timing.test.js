'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildWebhookBody,
  notifyWebhook,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
} = require('../src/notifiers/webhook.js');
const { NOTIFY_RETRY_DELAYS_MS } = require('../src/notifiers/retry.js');

const root = path.join(__dirname, '..');

test('message timing integration runner', () => {
  const runner = path.join(__dirname, '..', 'scripts', 'message-timing-runner.js');
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout || `runner exited ${r.status}`);
});

test('webhook retry logs shared request id and durations', async () => {
  const lines = [];
  const stamps = [0, 15, 100, 120];
  let stampIdx = 0;
  const now = () => {
    const v = stamps[Math.min(stampIdx, stamps.length - 1)];
    stampIdx += 1;
    return v;
  };
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) {
      return new Response('', { status: 500 });
    }
    return new Response(null, { status: 204 });
  };
  const sleeper = async (ms) => {
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      return new Promise(() => {});
    }
  };
  const result = await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook-url-token',
    secret: 'webhook-secret-token',
    payload: buildWebhookBody({
      account: 'work',
      from: 'from-token@example.com',
      subject: 'subject-token',
      date: '2026-11-01T00:00:00.000Z',
      message_id: '',
      path: '/abs/x.json',
      mailbox: 'INBOX',
      uid: 104,
      uid_validity: 1,
    }),
    fetchImpl,
    sleeper,
    log: (msg) => lines.push(msg),
    requestId: 'req-1',
    now,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(lines, [
    'webhook start mailbox INBOX uid 104 request req-1 attempt 1',
    'webhook response mailbox INBOX uid 104 request req-1 attempt 1 status 500 duration 15',
    'webhook start mailbox INBOX uid 104 request req-1 attempt 2',
    'webhook response mailbox INBOX uid 104 request req-1 attempt 2 status 204 duration 20',
  ]);
  for (const line of lines) {
    assert.ok(!line.includes('webhook-secret-token'));
  }
});

test('webhook timeout logs start without response', async () => {
  const lines = [];
  const fetchImpl = () => new Promise(() => {});
  const sleeper = async (ms) => {
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      return;
    }
  };
  const result = await notifyWebhook({
    webhookUrl: 'http://127.0.0.1:9/hook-url-token',
    secret: 'webhook-secret-token',
    payload: buildWebhookBody({
      account: 'work',
      from: 'a@example.com',
      subject: 'S',
      date: '2026-11-01T00:00:00.000Z',
      message_id: '',
      path: '/abs/x.json',
      mailbox: 'INBOX',
      uid: 1,
      uid_validity: 1,
    }),
    fetchImpl,
    sleeper,
    log: (msg) => lines.push(msg),
    requestId: 'req-timeout',
    attemptTimeoutMs: WEBHOOK_ATTEMPT_TIMEOUT_MS,
  });
  assert.equal(result.ok, false);
  assert.ok(lines.every((l) => l.startsWith('webhook start ')));
  assert.ok(!lines.some((l) => l.startsWith('webhook response ')));
  assert.equal(lines.length, 1 + NOTIFY_RETRY_DELAYS_MS.length);
});

test('FR1 log statements unchanged in source', () => {
  const snail = fs.readFileSync(path.join(root, 'snail.js'), 'utf8');
  const supervisor = fs.readFileSync(path.join(root, 'src/supervisor.js'), 'utf8');
  const mailStore = fs.readFileSync(path.join(root, 'src/mail-store.js'), 'utf8');
  const supervisorTest = fs.readFileSync(path.join(root, 'test/supervisor.test.js'), 'utf8');

  assert.match(snail, /\$\{new Date\(\)\.toISOString\(\)\} \[snail\] starting/);
  assert.match(supervisor, /function formatLogLine[\s\S]*new Date\(\)\.toISOString\(\)/);
  assert.match(supervisor, /createNotifyDelivery/);
  assert.match(supervisor, /delivery\.attemptAfterSave/);
  assert.match(supervisor, /imap disconnected: \$\{msg\}/);
  assert.match(mailStore, /mail save failed uid \$\{msg\.uid\}/);
  assert.match(supervisorTest, /formatLogLine uses UTC prefix and account tag/);
  assert.ok(supervisorTest.includes(String.raw`\.\d{3}Z \[snail\] \[work\] hello`));
});
