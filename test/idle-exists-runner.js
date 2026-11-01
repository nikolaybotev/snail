'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

/** @type {Promise<void> | null} */
let mockIdlePromise = null;
/** @type {(() => void) | null} */
let mockIdleResolve = null;
/** @type {EventEmitter | null} */
let liveImap = null;
let mailboxOpenCount = 0;
let uidNext = 101;
const uidValidity = 1;
/** @type {Map<number, object>} */
const messages = new Map();
let notifyCalls = 0;

const originalLoad = Module._load;
/** @type {typeof originalLoad} */
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'imapflow') {
    return {
      ImapFlow: class extends EventEmitter {
        constructor() {
          super();
          liveImap = this;
        }
        async connect() {}
        async mailboxOpen() {
          mailboxOpenCount += 1;
          if (mailboxOpenCount === 1) {
            return { uidValidity, uidNext: 101 };
          }
          return { uidValidity, uidNext };
        }
        async fetchOne(uidStr) {
          const uid = Number(uidStr);
          const msg = messages.get(uid);
          if (!msg) return null;
          return {
            envelope: msg.envelope,
            source: Buffer.from(msg.body ?? 'text'),
          };
        }
        idle() {
          mockIdlePromise = new Promise((resolve) => {
            mockIdleResolve = resolve;
          });
          return mockIdlePromise;
        }
      },
    };
  }
  if (request === 'mailparser') {
    return {
      simpleParser: async (source) => ({
        text: source.toString(),
        attachments: [],
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const snailPath = require.resolve('../snail.js');
delete require.cache[snailPath];

const { createImapFlowClient } = require('../snail.js');
const { runAccountLoop, IDLE_KEEPALIVE_MS } = require('../src/supervisor.js');
const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timeout');
}

/** Block keepalive and webhook attempt timeouts so fetchImpl can succeed. */
async function idleTestSleeper(ms) {
  if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS || ms >= IDLE_KEEPALIVE_MS) {
    return new Promise(() => {});
  }
}

(async () => {
  const mailDir = tempDir('snail-idle-exists-');
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 100,
      backlogUid: 0,
      lastUid: 100,
    }),
    { mode: 0o600 },
  );

  const account = {
    name: 'work',
    nameLine: 1,
    host: 'imap.example.com',
    port: 993,
    tls: 'on',
    user: 'you@example.com',
    password: 'inline-mail-pass',
    mailbox: 'INBOX',
    mail_dir: mailDir,
    mail_dirLine: 1,
    notifier: 'webhook',
    webhook_url: 'http://127.0.0.1:9/hook',
    webhook_secret: 'webhook-secret-value',
    webhook_auth: 'bearer',
    webhook_header: 'Authorization',
    openclaw_url: 'http://127.0.0.1:18789',
    openclaw_token: 'gateway-token-value',
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
  };

  const stopSignal = { stopped: false };
  const loop = runAccountLoop({
    account,
    secrets: { resolve: async (v) => v, clearCache: () => {} },
    imapFactory: (acct, password) => createImapFlowClient(acct, password),
    log: () => {},
    fetchImpl: async () => {
      notifyCalls += 1;
      return new Response('', { status: 200 });
    },
    stopSignal,
    sleeper: idleTestSleeper,
  });

  await waitFor(() => mockIdlePromise !== null);
  assert.ok(liveImap, 'mock imap client should exist');

  uidNext = 102;
  messages.set(101, {
    body: 'new mail',
    envelope: {
      messageId: '<exists-test@example.com>',
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'you@example.com' }],
      subject: 'exists test',
      date: new Date('2026-11-01T00:00:00.000Z'),
    },
  });

  liveImap.emit('exists');

  await waitFor(() => notifyCalls === 1);
  await waitFor(() =>
    fs.readdirSync(mailDir).some((f) => f.includes('_0000000101.json')),
  );

  assert.equal(notifyCalls, 1);
  const msgFiles = fs
    .readdirSync(mailDir)
    .filter((f) => f.endsWith('.json') && f !== '.snail-state.json');
  assert.equal(msgFiles.length, 1);
  assert.ok(mockIdleResolve, 'mock idle() should stay pending');
  let idleSettled = false;
  void mockIdlePromise.then(() => {
    idleSettled = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(idleSettled, false, 'mock idle() promise must still be pending');

  stopSignal.stopped = true;
  await loop;
})().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
