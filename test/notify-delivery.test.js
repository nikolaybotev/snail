'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNotifyDelivery,
  createRedeliverPollWatcher,
  REQUEST_POLL_MS,
} = require('../src/notify-delivery.js');
const {
  readNotifyLedger,
  upsertNotifyItem,
  isoFromMs,
  NOTIFY_DELAY_MS,
  writeRedeliverRequest,
} = require('../src/notify-ledger.js');
const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');

/** @type {{ releasePending?: () => void } | null} */
let activeWebhookSleeper = null;

/**
 * @param {(ms: number) => Promise<void>} [before]
 */
function makeDeliverySleeper(before = async () => {}) {
  /** @type {(() => void)[]} */
  const releases = [];
  const sleeper = async (ms) => {
    await before(ms);
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      await new Promise((resolve) => {
        releases.push(resolve);
      });
    }
  };
  sleeper.releasePending = () => {
    for (const resolve of releases) {
      resolve();
    }
    releases.length = 0;
  };
  activeWebhookSleeper = sleeper;
  return sleeper;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snail-ndel-'));
}

function baseAccount(mailDir) {
  return {
    name: 'work',
    mailbox: 'INBOX',
    mail_dir: mailDir,
    notifier: 'webhook',
    webhook_url: 'http://127.0.0.1:9/hook',
    webhook_auth: 'bearer',
    webhook_header: 'Authorization',
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
  };
}

test('AC2: due row reposts without rewriting message file', async () => {
  const mailDir = tempDir();
  const fname = '20260101T120000Z_1_0000000001.json';
  const body = JSON.stringify({ from: 'saved@example.com', subject: 'Saved', uid: 1 });
  fs.writeFileSync(path.join(mailDir, fname), body, { mode: 0o600 });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/1',
    account: 'work',
    uid: 1,
    uid_validity: 1,
    file: fname,
    attempts: 1,
    last_status: '500',
    next_attempt_at: isoFromMs(0),
    request_id: 'stable-req',
  });
  let posts = 0;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async (_url, init) => {
      posts += 1;
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.from, 'saved@example.com');
      assert.equal(payload.subject, 'Saved');
      return new Response('', { status: 500 });
    },
    now: () => 0,
    sleeper: makeDeliverySleeper(),
  });
  await delivery.runDueTurn();
  assert.equal(posts, 1);
  assert.equal(fs.readFileSync(path.join(mailDir, fname), 'utf8'), body);
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('AC3: 2xx removes row', async () => {
  const mailDir = tempDir();
  const fname = 'f.json';
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'S' }), {
    mode: 0o600,
  });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/2',
    account: 'work',
    uid: 2,
    uid_validity: 1,
    file: fname,
    attempts: 1,
    last_status: '500',
    next_attempt_at: isoFromMs(0),
    request_id: 'r1',
  });
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async () => new Response(null, { status: 204 }),
    now: () => 0,
    sleeper: makeDeliverySleeper(),
  });
  await delivery.runDueTurn();
  assert.equal(readNotifyLedger(mailDir).length, 0);
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('AC4: stable request_id across durable retries', async () => {
  const mailDir = tempDir();
  const fname = 'f.json';
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'S' }), {
    mode: 0o600,
  });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/3',
    account: 'work',
    uid: 3,
    uid_validity: 1,
    file: fname,
    attempts: 0,
    last_status: 'none',
    next_attempt_at: isoFromMs(0),
    request_id: 'req-stable',
  });
  const seen = [];
  let nowMs = 0;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: (line) => {
      if (line.startsWith('webhook start ')) {
        const m = /request (\S+)/.exec(line);
        if (m) seen.push(m[1]);
      }
    },
    fetchImpl: async () => new Response('', { status: 500 }),
    now: () => nowMs,
    sleeper: makeDeliverySleeper(async (ms) => {
      if (NOTIFY_DELAY_MS.includes(ms)) {
        nowMs += ms;
      }
    }),
  });
  for (let i = 0; i < 3; i += 1) {
    const row = readNotifyLedger(mailDir)[0];
    upsertNotifyItem(mailDir, { ...row, next_attempt_at: isoFromMs(nowMs) });
    await delivery.runDueTurn();
  }
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((id) => id === 'req-stable'));
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('durable webhook retries record NOTIFY_DELAY_MS sequence', async () => {
  const mailDir = tempDir();
  const fname = 'f.json';
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'S' }), {
    mode: 0o600,
  });
  let nowMs = 1_000_000;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async () => new Response(null, { status: 500 }),
    sleeper: makeDeliverySleeper(),
    now: () => nowMs,
  });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/9',
    account: 'work',
    uid: 9,
    uid_validity: 1,
    file: fname,
    attempts: 0,
    last_status: 'none',
    next_attempt_at: isoFromMs(nowMs),
    request_id: 'req-seq',
  });
  for (let i = 0; i < NOTIFY_DELAY_MS.length + 1; i += 1) {
    const row = readNotifyLedger(mailDir)[0];
    upsertNotifyItem(mailDir, { ...row, next_attempt_at: isoFromMs(nowMs) });
    await delivery.runDueTurn();
    if (i < NOTIFY_DELAY_MS.length) {
      nowMs += NOTIFY_DELAY_MS[i];
    }
  }
  const row = readNotifyLedger(mailDir)[0];
  assert.equal(row.attempts, NOTIFY_DELAY_MS.length + 1);
  assert.equal(row.last_status, '500');
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('AC8: redeliver request is applied by delivery turn', async () => {
  const mailDir = tempDir();
  const fname = '20260101T120000Z_1_0000000100.json';
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 1,
      backlogUid: 0,
      lastUid: 100,
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'R' }), {
    mode: 0o600,
  });
  writeRedeliverRequest(mailDir, fname);
  let posts = 0;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async () => {
      posts += 1;
      return new Response('', { status: 200 });
    },
    now: () => 0,
    sleeper: makeDeliverySleeper(),
  });
  await delivery.applyRedeliverRequests();
  assert.equal(posts, 1);
  assert.equal(readNotifyLedger(mailDir).length, 0);
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('redeliver poll watcher stops with account', async () => {
  const mailDir = tempDir();
  const delays = [];
  const stopSignal = { stopped: false };
  const watcher = createRedeliverPollWatcher({
    mailDir,
    pollMs: 50,
    sleeper: async (ms) => {
      if (ms === REQUEST_POLL_MS || ms === 50) {
        delays.push(ms);
        await new Promise((r) => setTimeout(r, 1));
      }
    },
    stopSignal,
  });
  watcher.start();
  await new Promise((r) => setTimeout(r, 120));
  const n = delays.length;
  watcher.stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(delays.length <= n + 2);
});

test('AC1: 400 responses advance next_attempt_at by NOTIFY_DELAY_MS', async () => {
  const mailDir = tempDir();
  const fname = 'f.json';
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'S' }), {
    mode: 0o600,
  });
  let nowMs = 5_000_000;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async () => new Response(null, { status: 400 }),
    sleeper: makeDeliverySleeper(),
    now: () => nowMs,
  });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/11',
    account: 'work',
    uid: 11,
    uid_validity: 1,
    file: fname,
    attempts: 0,
    last_status: 'none',
    next_attempt_at: isoFromMs(nowMs),
    request_id: 'req-ac1',
  });
  for (let i = 0; i < NOTIFY_DELAY_MS.length; i += 1) {
    const row = readNotifyLedger(mailDir)[0];
    upsertNotifyItem(mailDir, { ...row, next_attempt_at: isoFromMs(nowMs) });
    await delivery.runDueTurn();
    const after = readNotifyLedger(mailDir)[0];
    assert.equal(after.attempts, i + 1);
    assert.equal(after.last_status, '400');
    const expectedNext = nowMs + NOTIFY_DELAY_MS[i];
    assert.equal(after.next_attempt_at, isoFromMs(expectedNext));
    nowMs = expectedNext;
  }
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('corrupt retry queue still delivers main ledger rows', async () => {
  const mailDir = tempDir();
  const fname = 'f.json';
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'S' }), {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(mailDir, '.snail-notify-ledger-retry.json'), '{not-json', { mode: 0o600 });
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/12',
    account: 'work',
    uid: 12,
    uid_validity: 1,
    file: fname,
    attempts: 0,
    last_status: 'none',
    next_attempt_at: isoFromMs(0),
    request_id: 'req-corrupt',
  });
  const logs = [];
  let posts = 0;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: (line) => logs.push(line),
    fetchImpl: async () => {
      posts += 1;
      return new Response(null, { status: 204 });
    },
    now: () => 0,
    sleeper: makeDeliverySleeper(),
  });
  await delivery.runDueTurn();
  assert.ok(logs.some((l) => l.includes('notify ledger retry unreadable')));
  assert.equal(posts, 1);
  assert.equal(readNotifyLedger(mailDir).length, 0);
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});

test('AC9: runDueTurn skips saved file at or below lastUid without a row', async () => {
  const mailDir = tempDir();
  const fname = '20260101T120000Z_1_0000000099.json';
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 50,
      backlogUid: 0,
      lastUid: 100,
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(mailDir, fname), JSON.stringify({ from: 'a@x.com', subject: 'old' }), {
    mode: 0o600,
  });
  let posts = 0;
  const delivery = createNotifyDelivery({
    account: baseAccount(mailDir),
    notifierSecret: 'sec',
    openclawClient: null,
    log: () => {},
    fetchImpl: async () => {
      posts += 1;
      return new Response(null, { status: 204 });
    },
    now: () => 0,
    sleeper: makeDeliverySleeper(),
  });
  await delivery.runDueTurn();
  assert.equal(posts, 0);
  activeWebhookSleeper?.releasePending?.();
  activeWebhookSleeper = null;
});
