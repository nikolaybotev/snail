'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const SENTINELS = [
  'body-token',
  'subject-token',
  'from-token',
  'secret-token',
  'webhook-secret-token',
  'url-token',
];

/** @param {string[]} lines */
function assertNoSentinels(lines) {
  for (const line of lines) {
    for (const s of SENTINELS) {
      assert.ok(!line.includes(s), `sentinel ${s} in line: ${line}`);
    }
  }
}

/** @param {string[]} seq @param {string} needle */
function indexOfLine(seq, needle) {
  return seq.findIndex((l) => l === needle || l.startsWith(needle));
}

/**
 * @param {string[]} seq
 * @param {string[]} orderedPrefixes
 */
function assertOrderedSubsequence(seq, orderedPrefixes) {
  let j = 0;
  for (const line of seq) {
    const expected = orderedPrefixes[j];
    const matches = line === expected || line.startsWith(expected);
    if (matches) {
      j += 1;
      if (j === orderedPrefixes.length) return;
    }
  }
  throw new Error(
    `expected subsequence not found at step ${j + 1}/${orderedPrefixes.length}: ${orderedPrefixes[j]}\nseq=${JSON.stringify(seq)}`,
  );
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tokenMessage(extra = {}) {
  return {
    body: 'body-token payload',
    envelope: {
      messageId: '<msg@example.com>',
      from: [{ address: 'from-token@example.com' }],
      to: [{ address: 'you@example.com' }],
      subject: 'subject-token',
      date: new Date('2026-11-01T00:00:00.000Z'),
    },
    ...extra,
  };
}

/**
 * @param {{
 *   mailbox?: string,
 *   initialUidNext?: number,
 *   uidNextAfterExists?: number,
 * }} opts
 */
function installImapMock(opts = {}) {
  const mailbox = opts.mailbox ?? 'INBOX';
  const initialUidNext = opts.initialUidNext ?? 104;
  let uidNextAfterExists = opts.uidNextAfterExists ?? 105;

  /** @type {EventEmitter | null} */
  let liveImap = null;
  let mailboxOpenCount = 0;
  let uidNext = initialUidNext;
  const uidValidity = 1;
  /** @type {Map<number, object>} */
  const messages = new Map();
  let notifyCalls = 0;
  /** @type {string[]} */
  const sequence = [];

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
            sequence.push(`__mailboxOpen_${mailboxOpenCount}__`);
            if (mailboxOpenCount === 1) {
              return { uidValidity, uidNext };
            }
            return { uidValidity, uidNext: uidNextAfterExists };
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
            return new Promise(() => {});
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

  return {
    sequence,
    get liveImap() {
      return liveImap;
    },
    get notifyCalls() {
      return notifyCalls;
    },
    messages,
    mailbox,
    bumpNotify() {
      notifyCalls += 1;
    },
    restoreLoad() {
      Module._load = originalLoad;
    },
  };
}

const snailPath = require.resolve('../snail.js');

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timeout');
}

function captureLog(mock) {
  return (fullLine) => {
    const tag = '[snail] [work] ';
    const i = fullLine.indexOf(tag);
    if (i >= 0) {
      mock.sequence.push(fullLine.slice(i + tag.length));
    }
  };
}

async function runMainFlow() {
  const mock = installImapMock({});
  try {
    delete require.cache[snailPath];
    const { createImapFlowClient } = require('../snail.js');
    const { runAccountLoop, IDLE_KEEPALIVE_MS } = require('../src/supervisor.js');
    const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');
    const { REQUEST_POLL_MS } = require('../src/notify-delivery.js');

    const mailDir = tempDir('snail-msg-timing-');
    fs.writeFileSync(
      path.join(mailDir, '.snail-state.json'),
      JSON.stringify({
        uidValidity: 1,
        notifyBoundary: 102,
        backlogUid: 0,
        lastUid: 100,
      }),
      { mode: 0o600 },
    );
    mock.messages.set(101, tokenMessage());

    const account = {
      name: 'work',
      nameLine: 1,
      host: 'imap.example.com',
      port: 993,
      tls: 'on',
      user: 'you@example.com',
      password: 'secret-token',
      mailbox: 'INBOX',
      mail_dir: mailDir,
      mail_dirLine: 1,
      notifier: 'webhook',
      webhook_url: 'http://127.0.0.1:9/hook-url-token',
      webhook_secret: 'webhook-secret-token',
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
      log: captureLog(mock),
      fetchImpl: async () => {
        mock.bumpNotify();
        return new Response(null, { status: 204 });
      },
      stopSignal,
      sleeper: async (ms) => {
        if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS || ms === REQUEST_POLL_MS || ms >= IDLE_KEEPALIVE_MS) {
          return new Promise(() => {});
        }
      },
    });

    await waitFor(() => mock.liveImap !== null);
    assert.ok(!mock.sequence.some((l) => l.startsWith('exists mailbox')), 'catch-up must not log exists');

    assertOrderedSubsequence(mock.sequence, [
      'fetch start mailbox INBOX uid 101',
      'fetch end mailbox INBOX uid 101',
      'file write mailbox INBOX uid 101',
      'fetch start mailbox INBOX uid 102',
      'fetch end mailbox INBOX uid 102',
      'fetch start mailbox INBOX uid 103',
      'fetch end mailbox INBOX uid 103',
    ]);
    assert.equal(indexOfLine(mock.sequence, 'file write mailbox INBOX uid 102'), -1);
    assert.equal(indexOfLine(mock.sequence, 'file write mailbox INBOX uid 103'), -1);
    await waitFor(() => indexOfLine(mock.sequence, 'fetch end mailbox INBOX uid 103') >= 0, 10000);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(
      !mock.sequence.some((l) => l.startsWith('webhook start') && l.includes('uid 101')),
      'uid 101 must not webhook',
    );
    assert.ok(
      !mock.sequence.some((l) => l.startsWith('webhook start')),
      'no webhook before EXISTS',
    );

    const beforeExistsLen = mock.sequence.length;
    mock.messages.set(104, tokenMessage());
    mock.liveImap.emit('exists', { path: 'INBOX', count: 3, prevCount: 2 });

    const existsLine = 'exists mailbox INBOX path INBOX count 3 prevCount 2';
    await waitFor(() => mock.sequence.includes(existsLine), 15000);

    assert.ok(!/\buid\b/.test(existsLine));
    await waitFor(() => {
      const existsIdx = mock.sequence.indexOf(existsLine);
      if (existsIdx < 0) return false;
      return mock.sequence
        .slice(existsIdx + 1)
        .some((l) => /^__mailboxOpen_\d+__$/.test(l));
    }, 15000);
    await waitFor(() => mock.notifyCalls >= 1, 15000);
    const tail = mock.sequence.slice(beforeExistsLen);
    assertOrderedSubsequence(tail, [
      existsLine,
      'fetch start mailbox INBOX uid 104',
      'fetch end mailbox INBOX uid 104',
      'file write mailbox INBOX uid 104',
      'webhook start mailbox INBOX uid 104 request ',
      'webhook response mailbox INBOX uid 104 request ',
      'notify ok uid 104 attempts',
    ]);

    const startLine = tail.find((l) => l.startsWith('webhook start mailbox INBOX uid 104 request '));
    const responseLine = tail.find((l) =>
      l.startsWith('webhook response mailbox INBOX uid 104 request '),
    );
    assert.ok(startLine);
    assert.ok(responseLine);
    assert.match(startLine, /^webhook start mailbox INBOX uid 104 request .+ attempt 1$/);
    assert.match(
      responseLine,
      /^webhook response mailbox INBOX uid 104 request .+ attempt 1 status 204 duration \d+$/,
    );
    const id = startLine.split(' request ')[1].split(' attempt ')[0];
    assert.equal(id, responseLine.split(' request ')[1].split(' attempt ')[0]);
    assert.match(id, /^[0-9a-f-]{36}$/i);

    const writeIdx = indexOfLine(tail, 'file write mailbox INBOX uid 104');
    const notifyIdx = indexOfLine(tail, 'notify ok uid 104');
    assert.ok(writeIdx >= 0 && notifyIdx > writeIdx);

    for (const l of tail) {
      if (l.startsWith('fetch ') || l.startsWith('file write')) {
        assert.ok(!l.includes(' request '));
      }
    }

    assertNoSentinels(mock.sequence.filter((l) => !l.startsWith('__')));

    stopSignal.stopped = true;
    await loop;
  } finally {
    mock.restoreLoad();
  }
}

async function runSpacesMailbox() {
  const mock = installImapMock({ mailbox: 'IN BOX', initialUidNext: 102, uidNextAfterExists: 102 });
  try {
    delete require.cache[snailPath];
    const { createImapFlowClient } = require('../snail.js');
    const { runAccountLoop, IDLE_KEEPALIVE_MS } = require('../src/supervisor.js');
    const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');
    const { REQUEST_POLL_MS } = require('../src/notify-delivery.js');

    const mailDir = tempDir('snail-msg-timing-sp-');
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
    mock.messages.set(101, tokenMessage());

    const account = {
      name: 'work',
      nameLine: 1,
      host: 'imap.example.com',
      port: 993,
      tls: 'on',
      user: 'you@example.com',
      password: 'secret-token',
      mailbox: 'IN BOX',
      mail_dir: mailDir,
      mail_dirLine: 1,
      notifier: 'webhook',
      webhook_url: 'http://127.0.0.1:9/hook-url-token',
      webhook_secret: 'webhook-secret-token',
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
      log: captureLog(mock),
      fetchImpl: async () => new Response(null, { status: 204 }),
      stopSignal,
      sleeper: async (ms) => {
        if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS || ms === REQUEST_POLL_MS || ms >= IDLE_KEEPALIVE_MS) {
          return new Promise(() => {});
        }
      },
    });

    await waitFor(() => mock.sequence.some((l) => l.startsWith('fetch start mailbox IN%20BOX')));
    const fetchStart = mock.sequence.find((l) => l.startsWith('fetch start mailbox IN%20BOX'));
    assert.ok(fetchStart);
    assert.match(fetchStart, /^fetch start mailbox IN%20BOX uid \d+$/);

    mock.liveImap.emit('exists', { path: 'A B', count: 1, prevCount: 0 });
    await waitFor(() => mock.sequence.some((l) => l.includes('path A%20B')));

    const existsLine = mock.sequence.find((l) => l.startsWith('exists mailbox IN%20BOX'));
    assert.ok(existsLine);
    assert.ok(existsLine.includes('path A%20B'));

    stopSignal.stopped = true;
    await loop;
  } finally {
    mock.restoreLoad();
  }
}

async function runArchivePath() {
  const mock = installImapMock({ initialUidNext: 102, uidNextAfterExists: 102 });
  try {
    delete require.cache[snailPath];
    const { createImapFlowClient } = require('../snail.js');
    const { runAccountLoop, IDLE_KEEPALIVE_MS } = require('../src/supervisor.js');
    const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');
    const { REQUEST_POLL_MS } = require('../src/notify-delivery.js');

    const mailDir = tempDir('snail-msg-timing-ar-');
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
    mock.messages.set(101, tokenMessage());

    const account = {
      name: 'work',
      nameLine: 1,
      host: 'imap.example.com',
      port: 993,
      tls: 'on',
      user: 'you@example.com',
      password: 'secret-token',
      mailbox: 'INBOX',
      mail_dir: mailDir,
      mail_dirLine: 1,
      notifier: 'webhook',
      webhook_url: 'http://127.0.0.1:9/hook-url-token',
      webhook_secret: 'webhook-secret-token',
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
      log: captureLog(mock),
      fetchImpl: async () => new Response(null, { status: 204 }),
      stopSignal,
      sleeper: async (ms) => {
        if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS || ms === REQUEST_POLL_MS || ms >= IDLE_KEEPALIVE_MS) {
          return new Promise(() => {});
        }
      },
    });

    await waitFor(() => mock.liveImap !== null);
    mock.liveImap.emit('exists', { path: 'Archive', count: 1, prevCount: 0 });
    await waitFor(() =>
      mock.sequence.some((l) => l === 'exists mailbox INBOX path Archive count 1 prevCount 0'),
    );

    stopSignal.stopped = true;
    await loop;
  } finally {
    mock.restoreLoad();
  }
}

async function runAllFlows() {
  await runMainFlow();
  await runSpacesMailbox();
  await runArchivePath();
}

if (require.main === module) {
  runAllFlows().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
