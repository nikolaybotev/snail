'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const imapkit = require('imapkit');
const { WebSocketServer } = require('ws');

const { createImapFlowClient, IDLE_REFRESH_MS } = require('../snail.js');
const { ImapFlow } = require('imapflow');
const {
  startSupervisor,
  IDLE_KEEPALIVE_MS,
  formatLogLine,
} = require('../src/supervisor.js');
const { readSnailState, createMailStore } = require('../src/mail-store.js');
const { WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');
const { NOTIFY_RETRY_DELAYS_MS } = require('../src/notifiers/retry.js');
const { formatWakeText } = require('../src/notifiers/openclaw.js');

const HARNESS_PLUGINS_MIN = ['idle', 'namespace', 'id', 'auth-plain', 'sasl-ir', 'enable'];
const HARNESS_PLUGINS = [...HARNESS_PLUGINS_MIN, 'condstore'];
const HARNESS_PASSWORD = 'imap-pass8!';
const NOTIFIER_SECRET = 'notify-sc9!';
const IMAP_USER = 'testuser';
const serial = { concurrency: 1 };
/** @type {ReturnType<typeof createHarnessSleeper> | null} */
let activeHarnessSleeper = null;

/** @type {string[]} */
const observedRemoteAddresses = [];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timeout');
}

function buildRawMessage({ from = 'sender@example.com', subject = 'Subject', body = 'body', messageId }) {
  const mid = messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`;
  return (
    `From: ${from}\r\n` +
    `Subject: ${subject}\r\n` +
    `Message-ID: ${mid}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `\r\n${body}\r\n`
  );
}

function messageEntry(fields) {
  const { uid, ...rest } = fields;
  const entry = { raw: buildRawMessage(rest) };
  if (uid != null) entry.uid = uid;
  return entry;
}

/**
 * @param {{
 *   storage?: object,
 *   script?: import('imapkit').ScriptRule | import('imapkit').ScriptRule[],
 *   users?: Record<string, { password: string }>,
 * }} [options]
 */
async function startHarnessServer(options = {}) {
  const server = imapkit({
    plugins: options.plugins ?? HARNESS_PLUGINS,
    users: options.users ?? { [IMAP_USER]: { password: HARNESS_PASSWORD } },
    storage: options.storage,
    script: options.script,
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(undefined)));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  for (const s of server.control.sessions()) {
    if (s.remoteAddress) observedRemoteAddresses.push(s.remoteAddress);
  }
  return {
    server,
    port,
    control: server.control,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    trackSessions() {
      for (const s of server.control.sessions()) {
        if (s.remoteAddress) observedRemoteAddresses.push(s.remoteAddress);
      }
    },
  };
}

/**
 * @param {number} imapPort
 * @param {string} mailDir
 * @param {Partial<ReturnType<typeof baseHarnessAccount>>} overrides
 */
function baseHarnessAccount(imapPort, mailDir, overrides = {}) {
  return {
    name: 'bench-a',
    nameLine: 1,
    host: '127.0.0.1',
    port: imapPort,
    tls: 'off',
    user: IMAP_USER,
    password: HARNESS_PASSWORD,
    mailbox: 'INBOX',
    mail_dir: mailDir,
    mail_dirLine: 1,
    notifier: 'webhook',
    webhook_url: 'http://127.0.0.1:9/hook',
    webhook_secret: NOTIFIER_SECRET,
    webhook_auth: 'bearer',
    webhook_header: 'Authorization',
    ...overrides,
  };
}

/**
 * FR14 harness sleeper factory.
 * @param {{
 *   holdWebhookAttempt?: boolean,
 *   resolveWebhookAttempt?: boolean,
 *   holdReconnect5000?: boolean,
 * }} [options]
 */
function createHarnessSleeper(options = {}) {
  /** @type {number[]} */
  const delays = [];
  /** @type {(() => void) | null} */
  let releaseKeepalive = null;
  /** @type {(() => void) | null} */
  let releaseReconnect5000 = null;

  const sleeper = async (ms) => {
    delays.push(ms);
    if (ms === IDLE_KEEPALIVE_MS) {
      await new Promise((resolve) => {
        releaseKeepalive = resolve;
      });
      return;
    }
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS) {
      if (options.holdWebhookAttempt) {
        await new Promise(() => {});
        return;
      }
      if (options.resolveWebhookAttempt) {
        return;
      }
      await new Promise(() => {});
      return;
    }
    if (ms === 5000 && options.holdReconnect5000) {
      await new Promise((resolve) => {
        releaseReconnect5000 = resolve;
      });
    }
  };

  const api = {
    sleeper,
    delays,
    releaseKeepalive: () => {
      releaseKeepalive?.();
    },
    releaseReconnect5000: () => {
      releaseReconnect5000?.();
    },
  };
  activeHarnessSleeper = api;
  return api;
}

async function stopHarness(sup, fr14In) {
  const fr14 = fr14In ?? activeHarnessSleeper;
  fr14?.releaseKeepalive();
  fr14?.releaseReconnect5000();
  sup.stop();
  await sup.stopAndWait();
}

function inlineSecretResolver() {
  return {
    async resolve(value) {
      return value;
    },
    knownSecrets() {
      return [];
    },
  };
}

/**
 * @param {ReturnType<typeof createHarnessSleeper>} fr14
 * @param {object} config
 * @param {(line: string) => void} [onLog]
 */
async function runHarnessSupervisor(
  fr14,
  config,
  onLog = () => {},
  fetchImpl,
  imapFactory = createImapFlowClient,
) {
  const sup = await startSupervisor({
    config,
    log: onLog,
    sleeper: fr14.sleeper,
    imapFactory,
    secretResolverFactory: inlineSecretResolver,
    fetchImpl,
  });
  return sup;
}

/**
 * @returns {{ get options(): import('imapflow').ImapFlowOptions | null, restore: () => void }}
 */
function installImapFlowOptionsCapture() {
  const imapflowMod = require('imapflow');
  const Real = imapflowMod.ImapFlow;
  /** @type {import('imapflow').ImapFlowOptions | null} */
  let captured = null;
  imapflowMod.ImapFlow = class CapturingImapFlow extends Real {
    constructor(opts) {
      captured = opts;
      super(opts);
    }
  };
  return {
    get options() {
      return captured;
    },
    restore() {
      imapflowMod.ImapFlow = Real;
    },
  };
}

/**
 * @param {{ direction: 'in' | 'out', data: Buffer }[]} traceEvents
 */
function traceClientCommandTokens(traceEvents) {
  /** @type {('IDLE' | 'DONE' | 'NOOP')[]} */
  const tokens = [];
  for (const ev of traceEvents) {
    if (ev.direction !== 'in') continue;
    const text = ev.data.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line === 'DONE') tokens.push('DONE');
      else if (/\bIDLE\b/.test(line)) tokens.push('IDLE');
      else if (/\bNOOP\b/.test(line)) tokens.push('NOOP');
    }
  }
  return tokens;
}

test('AC1: first start saves existing mail without waking', serial, async () => {
  const mailDir = tempDir('snail-h-ac1-');
  const imap = await startHarnessServer({
    storage: {
      INBOX: {
        uidvalidity: 1,
        uidnext: 3,
        messages: [
          messageEntry({ uid: 1, subject: 'one' }),
          messageEntry({ uid: 2, subject: 'two' }),
        ],
      },
    },
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let posts = 0;
  const hook = http.createServer((_req, res) => {
    posts += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imap.port, mailDir, {
        webhook_url: `http://127.0.0.1:${hookPort}/hook`,
      }),
    ],
  });
  await waitFor(() => readSnailState(mailDir)?.lastUid === 2);
  imap.trackSessions();
  assert.equal(posts, 0);
  const state = readSnailState(mailDir);
  assert.equal(state.notifyBoundary, 3);
  assert.equal(state.lastUid, 2);
  await stopHarness(sup, fr14);
  hook.close();
  await imap.close();
});

test('AC2 AC6: live EXISTS while IDLE saves once and wakes once', serial, async () => {
  const mailDir = tempDir('snail-h-ac2-');
  const imap = await startHarnessServer();
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  /** @type {Record<string, string>} */
  let lastHeaders = {};
  let posts = 0;
  /** @type {object | null} */
  let webhookPayload = null;
  const hook = http.createServer((req, res) => {
    posts += 1;
    lastHeaders = { ...req.headers };
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      webhookPayload = JSON.parse(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imap.port, mailDir, {
        webhook_url: `http://127.0.0.1:${hookPort}/hook`,
        webhook_auth: 'bearer',
      }),
    ],
  });
  await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
  imap.control.addMessage('INBOX', {
    raw: buildRawMessage({ from: 'ada@example.com', subject: 'live-exists' }),
  });
  await waitFor(() => posts === 1);
  imap.trackSessions();
  assert.equal(posts, 1);
  assert.ok(webhookPayload);
  assert.equal(webhookPayload.account, 'bench-a');
  assert.equal(typeof webhookPayload.uid, 'number');
  assert.equal(typeof webhookPayload.uid_validity, 'number');
  assert.ok(!('modseq' in webhookPayload));
  assert.equal(lastHeaders.authorization, `Bearer ${NOTIFIER_SECRET}`);
  const msgPath = path.join(mailDir, fs.readdirSync(mailDir).find((f) => f.endsWith('.json') && !f.startsWith('.')));
  assert.ok(fs.existsSync(msgPath));
  await stopHarness(sup, fr14);
  hook.close();
  await imap.close();
});

test('AC3: resume after downtime saves new mail once', serial, async () => {
  const mailDir = tempDir('snail-h-ac3-');
  const imap = await startHarnessServer();
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let posts = 0;
  const hook = http.createServer((_req, res) => {
    posts += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const account = baseHarnessAccount(imap.port, mailDir, {
    webhook_url: `http://127.0.0.1:${hookPort}/hook`,
  });
  let sup = await runHarnessSupervisor(fr14, { accounts: [account] });
  await waitFor(() => readSnailState(mailDir) !== null);
  await stopHarness(sup, fr14);
  imap.control.addMessage('INBOX', { raw: buildRawMessage({ subject: 'while-down' }) });
  posts = 0;
  const fr14b = createHarnessSleeper({ holdWebhookAttempt: true });
  sup = await runHarnessSupervisor(fr14b, { accounts: [account] });
  await waitFor(() => posts === 1);
  const files = fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.equal(files.length, 1);
  await stopHarness(sup, fr14b);
  const fr14c = createHarnessSleeper({ holdWebhookAttempt: true });
  posts = 0;
  sup = await runHarnessSupervisor(fr14c, { accounts: [account] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(posts, 0);
  await stopHarness(sup, fr14c);
  hook.close();
  await imap.close();
});

test('AC3: UIDVALIDITY change resyncs without waking', serial, async () => {
  const mailDir = tempDir('snail-h-uv-');
  const imap = await startHarnessServer({
    storage: {
      INBOX: {
        uidvalidity: 1,
        uidnext: 2,
        messages: [messageEntry({ uid: 1, subject: 'old' })],
      },
    },
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let posts = 0;
  const hook = http.createServer((_req, res) => {
    posts += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const account = baseHarnessAccount(imap.port, mailDir, {
    webhook_url: `http://127.0.0.1:${hookPort}/hook`,
  });
  let sup = await runHarnessSupervisor(fr14, { accounts: [account] });
  try {
    await waitFor(() => readSnailState(mailDir)?.lastUid === 1);
  } finally {
    await stopHarness(sup, fr14);
  }
  const oldFiles = fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  imap.control.resetUidValidity('INBOX', { uidvalidity: 2 });
  posts = 0;
  const fr14b = createHarnessSleeper({ holdWebhookAttempt: true });
  sup = await runHarnessSupervisor(fr14b, { accounts: [account] });
  try {
    await waitFor(() => readSnailState(mailDir)?.uidValidity === 2, 15000);
    await waitFor(() => readSnailState(mailDir)?.backlogUid === 1, 15000);
    assert.equal(posts, 0);
    for (const f of oldFiles) {
      assert.ok(fs.existsSync(path.join(mailDir, f)));
    }
    await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
    imap.control.addMessage('INBOX', { raw: buildRawMessage({ subject: 'after-uv' }) });
    await waitFor(() => posts === 1, 15000);
  } finally {
    await stopHarness(sup, fr14b);
    hook.close();
    await imap.close();
  }
});

test('AC5: connect failures double reconnect delay then reset after success', serial, async () => {
  const mailDir = tempDir('snail-h-ac5-');
  const imap = await startHarnessServer({
    script: {
      on: 'command',
      command: 'AUTHENTICATE PLAIN',
      times: 3,
      send: '$TAG NO [AUTHENTICATIONFAILED] bad\r\n',
    },
  });
  const fr14 = createHarnessSleeper({ resolveWebhookAttempt: true });
  const sup = await runHarnessSupervisor(
    fr14,
    {
      accounts: [
        baseHarnessAccount(imap.port, mailDir, {
          notifier: 'webhook',
          webhook_url: 'http://127.0.0.1:9/nope',
        }),
      ],
    },
  );
  await waitFor(() => fr14.delays.includes(5000));
  await waitFor(() => fr14.delays.includes(10000));
  await waitFor(() => fr14.delays.includes(20000));
  assert.ok(!fr14.delays.includes(0));
  imap.trackSessions();
  await stopHarness(sup, fr14);
  await imap.close();
});

test('AC5: UNAVAILABLE and recovered drop sleep 5000 without doubling', serial, async () => {
  const mailDir = tempDir('snail-h-unavail-');
  let selectCount = 0;
  const imap = await startHarnessServer({
    script: {
      on: 'command',
      command: 'SELECT',
      when: () => {
        selectCount += 1;
        return selectCount === 1;
      },
      send: '$TAG NO [UNAVAILABLE] Try again later\r\n',
    },
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [baseHarnessAccount(imap.port, mailDir)],
  });
  await waitFor(() => readSnailState(mailDir) !== null);
  const fives = fr14.delays.filter((d) => d === 5000);
  assert.ok(fives.length >= 1);
  assert.ok(!fr14.delays.includes(10000));
  imap.trackSessions();
  await stopHarness(sup, fr14);
  await imap.close();
});

test('AC6: webhook timeout and 500 retries leave one file and advance lastUid', serial, async () => {
  const lines = [];
  const hangImap = await startHarnessServer();
  const hangDir = tempDir('snail-h-wh-hang-');
  const hangFr14 = createHarnessSleeper({ resolveWebhookAttempt: true });
  let hangHookHits = 0;
  const hangHook = http.createServer((_req, _res) => {
    hangHookHits += 1;
  });
  await new Promise((r) => hangHook.listen(0, '127.0.0.1', r));
  const hangPort = hangHook.address().port;
  let sup = await runHarnessSupervisor(
    hangFr14,
    {
      accounts: [
        baseHarnessAccount(hangImap.port, hangDir, {
          webhook_url: `http://127.0.0.1:${hangPort}/hook`,
        }),
      ],
    },
    (line) => lines.push(line),
  );
  await waitFor(() => hangImap.control.sessions().some((s) => s.state === 'Selected'));
  hangImap.control.addMessage('INBOX', { raw: buildRawMessage({ subject: 'hang' }) });
  await waitFor(() => lines.some((l) => l.includes('notify failed')));
  await stopHarness(sup, hangFr14);
  hangHook.close();
  assert.equal(
    fs.readdirSync(hangDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length,
    1,
  );
  assert.equal(readSnailState(hangDir).lastUid, 1);
  assert.deepEqual(
    hangFr14.delays.filter((d) => NOTIFY_RETRY_DELAYS_MS.includes(d)),
    NOTIFY_RETRY_DELAYS_MS,
  );
  await hangImap.close();

  const errImap = await startHarnessServer();
  const errDir = tempDir('snail-h-wh-500-');
  const errFr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response('', { status: 500 });
  };
  sup = await runHarnessSupervisor(
    errFr14,
    {
      accounts: [
        baseHarnessAccount(errImap.port, errDir, {
          webhook_url: 'http://127.0.0.1:9/hook',
        }),
      ],
    },
    (line) => lines.push(line),
    fetchImpl,
  );
  await waitFor(() => errImap.control.sessions().some((s) => s.state === 'Selected'));
  errImap.control.addMessage('INBOX', { raw: buildRawMessage({ subject: '500' }) });
  await waitFor(() => lines.filter((l) => l.includes('notify failed')).length >= 2);
  await stopHarness(sup, errFr14);
  assert.equal(fetchCount, 1 + NOTIFY_RETRY_DELAYS_MS.length);
  assert.equal(
    fs.readdirSync(errDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length,
    1,
  );
  assert.equal(readSnailState(errDir).lastUid, 1);
  await errImap.close();
});

test('AC6: raw auth header and OpenClaw wake', serial, async () => {
  const mailDir = tempDir('snail-h-oc-');
  const imap = await startHarnessServer();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  /** @type {object[]} */
  const wakes = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'connect') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'connect' }));
      }
      if (msg.method === 'wake') {
        wakes.push(msg.params);
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'wake' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', reject);
  });
  const gwPort = /** @type {{ port: number }} */ (wss.address()).port;
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imap.port, mailDir, {
        name: 'bench-oc',
        notifier: 'openclaw',
        openclaw_url: `http://127.0.0.1:${gwPort}`,
        openclaw_token: 'openclaw-tok8',
      }),
    ],
  });
  await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
  await new Promise((r) => setTimeout(r, 200));
  imap.control.addMessage('INBOX', {
    raw: buildRawMessage({ from: 'ada@example.com', subject: 'wake-me' }),
  });
  await waitFor(() => wakes.length === 1, 15000);
  const msgFile = fs.readdirSync(mailDir).find((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.ok(msgFile);
  const expected = formatWakeText('ada@example.com', 'wake-me', path.join(mailDir, msgFile));
  assert.equal(wakes[0].text, expected);
  assert.equal(wakes[0].mode, 'now');
  await stopHarness(sup, fr14);
  wss.close();
  await imap.close();
});

test('AC7: account B wakes while account A reconnect sleep is pending', serial, async () => {
  const mailA = tempDir('snail-h-a7a-');
  const mailB = tempDir('snail-h-a7b-');
  const imapA = await startHarnessServer({
    script: {
      on: 'command',
      command: 'AUTHENTICATE PLAIN',
      times: 1,
      send: '$TAG NO [AUTHENTICATIONFAILED] hold\r\n',
    },
  });
  const imapB = await startHarnessServer();
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true, holdReconnect5000: true });
  let posts = 0;
  const hook = http.createServer((_req, res) => {
    posts += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imapA.port, mailA, {
        name: 'acct-alpha',
        webhook_url: `http://127.0.0.1:${hookPort}/a`,
      }),
      baseHarnessAccount(imapB.port, mailB, {
        name: 'acct-bravo',
        webhook_url: `http://127.0.0.1:${hookPort}/b`,
      }),
    ],
  });
  await waitFor(() => fr14.delays.includes(5000));
  await waitFor(() => imapB.control.sessions().some((s) => s.state === 'Selected'));
  imapB.control.addMessage('INBOX', {
    raw: buildRawMessage({ subject: 'b-live' }),
  });
  await waitFor(() => posts === 1);
  imapA.trackSessions();
  imapB.trackSessions();
  await stopHarness(sup, fr14);
  hook.close();
  await imapA.close();
  await imapB.close();
});

test('AC4: wide UID boundary, MODSEQ BigInt on wire, unsafe UIDVALIDITY', serial, async () => {
  const wideModseq = 9223372036854775807n;
  const mailDir = tempDir('snail-h-ac4-');
  const uidValidityMax = 4294967295;
  const lastBacklogUid = 4294967294;
  const store = createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
    onWake: async () => 'ok',
  });
  store.ensureMailboxState(uidValidityMax, uidValidityMax);
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: uidValidityMax,
      notifyBoundary: uidValidityMax,
      backlogUid: lastBacklogUid,
      lastUid: lastBacklogUid,
    }),
    { mode: 0o600 },
  );
  await store.saveOneMessage({
    uid: lastBacklogUid,
    uidValidity: uidValidityMax,
    subject: 'backlog',
    body: 'backlog body',
    from: [{ address: 'sender@example.com' }],
    messageId: '<backlog-max@example.com>',
    envelopeDate: new Date('2020-01-01T00:00:00Z'),
  });
  const imap = await startHarnessServer({
    plugins: HARNESS_PLUGINS_MIN,
    storage: {
      INBOX: {
        uidvalidity: uidValidityMax,
        uidnext: uidValidityMax,
        messages: [
          messageEntry({
            uid: lastBacklogUid,
            subject: 'backlog',
          }),
        ],
      },
    },
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let posts = 0;
  /** @type {object | null} */
  let payload = null;
  const hook = http.createServer((req, res) => {
    posts += 1;
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      payload = JSON.parse(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  let sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imap.port, mailDir, {
        webhook_url: `http://127.0.0.1:${hookPort}/hook`,
      }),
    ],
  });
  await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
  imap.control.addMessage('INBOX', {
    raw: buildRawMessage({ subject: 'max-uid' }),
  });
  await waitFor(() => posts === 1);
  assert.equal(readSnailState(mailDir).lastUid, uidValidityMax);
  assert.equal(payload.uid, uidValidityMax);
  assert.equal(payload.uid_validity, uidValidityMax);
  assert.ok(!('modseq' in payload));
  await stopHarness(sup, fr14);

  const modseqImap = await startHarnessServer({
    plugins: HARNESS_PLUGINS,
    script: {
      on: 'response',
      command: 'SELECT',
      untagged: true,
      after: () => `* OK [HIGHESTMODSEQ ${String(wideModseq)}] \r\n`,
    },
  });
  const modseqClient = new ImapFlow({
    host: '127.0.0.1',
    port: modseqImap.port,
    secure: false,
    disableAutoIdle: true,
    auth: { user: IMAP_USER, pass: HARNESS_PASSWORD },
    logger: false,
  });
  await modseqClient.connect();
  const modseqBox = await modseqClient.mailboxOpen('INBOX');
  assert.equal(modseqBox.highestModseq, wideModseq);
  await modseqClient.logout();
  await modseqImap.close();

  const unsafeDir = tempDir('snail-h-unsafe-');
  const unsafeImap = await startHarnessServer({
    storage: { INBOX: { uidvalidity: 1, uidnext: 2, messages: [] } },
    script: {
      on: 'response',
      command: 'SELECT',
      untagged: true,
      match: /UIDVALIDITY/,
      send: '* OK [UIDVALIDITY 9007199254740993] \r\n',
    },
  });
  const fr14c = createHarnessSleeper({ resolveWebhookAttempt: true });
  const lines = [];
  sup = await runHarnessSupervisor(
    fr14c,
    { accounts: [baseHarnessAccount(unsafeImap.port, unsafeDir)] },
    (line) => lines.push(line),
  );
  await waitFor(() => fr14c.delays.filter((d) => d === 5000).length >= 1);
  assert.ok(!fs.existsSync(path.join(unsafeDir, '.snail-state.json')));
  assert.equal(
    fs.readdirSync(unsafeDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length,
    0,
  );
  await stopHarness(sup, fr14c);
  hook.close();
  await imap.close();
  await unsafeImap.close();
});

test('AC8: secrets redacted in log lines; sockets stay on 127.0.0.1', serial, () => {
  const passwordLine = formatLogLine('bench-a', `auth failed password ${HARNESS_PASSWORD}`, [HARNESS_PASSWORD]);
  const secretLine = formatLogLine('bench-a', `notify failed secret ${NOTIFIER_SECRET}`, [NOTIFIER_SECRET]);
  assert.match(passwordLine, /\[redacted\]/);
  assert.match(secretLine, /\[redacted\]/);
  assert.doesNotMatch(passwordLine, new RegExp(HARNESS_PASSWORD));
  assert.doesNotMatch(secretLine, new RegExp(NOTIFIER_SECRET));
  for (const addr of observedRemoteAddresses) {
    assert.equal(addr, '127.0.0.1');
  }
});

test('AC1 idle refresh: broken maxIdleTime logs Socket timeout', serial, async () => {
  const mailDir = tempDir('snail-h-idle-br-');
  const imap = await startHarnessServer({ plugins: HARNESS_PLUGINS_MIN });
  /** @type {{ direction: 'in' | 'out', data: Buffer }[]} */
  const traceEvents = [];
  imap.server.on('trace', (ev) => {
    traceEvents.push(ev);
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true, holdReconnect5000: true });
  const capture = installImapFlowOptionsCapture();
  const lines = [];
  const sup = await runHarnessSupervisor(
    fr14,
    { accounts: [baseHarnessAccount(imap.port, mailDir, { name: 'idle-broken' })] },
    (line) => lines.push(line),
    undefined,
    (account, password) =>
      createImapFlowClient(account, password, { socketTimeout: 400, maxIdleTime: false }),
  );
  try {
    assert.ok(capture.options);
    assert.equal(capture.options.maxIdleTime, false);
    assert.equal(capture.options.socketTimeout, 400);
    await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
    await waitFor(() => lines.some((l) => l.includes('imap disconnected: Socket timeout')), 5000);
    const tokens = traceClientCommandTokens(traceEvents);
    assert.equal(tokens.filter((t) => t === 'IDLE').length, 1);
    assert.ok(tokens.includes('DONE'));
    assert.ok(tokens.includes('NOOP'));
    assert.ok(!tokens.slice(tokens.indexOf('NOOP') + 1).includes('IDLE'));
  } finally {
    capture.restore();
    await stopHarness(sup, fr14);
    await imap.close();
  }
});

test('AC2 idle refresh: maxIdleTime under socketTimeout stays connected', serial, async () => {
  const mailDir = tempDir('snail-h-idle-ok-');
  const imap = await startHarnessServer({ plugins: HARNESS_PLUGINS_MIN });
  /** @type {{ direction: 'in' | 'out', data: Buffer }[]} */
  const traceEvents = [];
  imap.server.on('trace', (ev) => {
    traceEvents.push(ev);
  });
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true, holdReconnect5000: true });
  const lines = [];
  let posts = 0;
  /** @type {object | null} */
  let webhookPayload = null;
  const hook = http.createServer((req, res) => {
    posts += 1;
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      webhookPayload = JSON.parse(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const sup = await runHarnessSupervisor(
    fr14,
    {
      accounts: [
        baseHarnessAccount(imap.port, mailDir, {
          name: 'idle-fixed',
          webhook_url: `http://127.0.0.1:${hookPort}/hook`,
        }),
      ],
    },
    (line) => lines.push(line),
    undefined,
    (account, password) =>
      createImapFlowClient(account, password, { socketTimeout: 500, maxIdleTime: 150 }),
  );
  await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
  await waitFor(() => traceClientCommandTokens(traceEvents).filter((t) => t === 'IDLE').length >= 2, 3000);
  const tokens = traceClientCommandTokens(traceEvents);
  const secondIdle = tokens.indexOf('IDLE', tokens.indexOf('IDLE') + 1);
  assert.ok(tokens.slice(0, secondIdle).includes('DONE'));
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(!lines.some((l) => l.includes('Socket timeout')));
  imap.control.addMessage('INBOX', {
    raw: buildRawMessage({ subject: 'idle-refresh-live' }),
  });
  await waitFor(() => posts === 1);
  assert.equal(posts, 1);
  assert.ok(webhookPayload);
  assert.ok(!('body' in webhookPayload));
  await stopHarness(sup, fr14);
  hook.close();
  await imap.close();
});

test('AC3 idle refresh: production IDLE_REFRESH_MS and two-argument options', serial, async () => {
  assert.equal(IDLE_REFRESH_MS, 240000);
  assert.ok(IDLE_REFRESH_MS < 5 * 60 * 1000);
  assert.ok(IDLE_REFRESH_MS < 10 * 60 * 1000);
  const mailDir = tempDir('snail-h-idle-ac3-');
  const imap = await startHarnessServer({ plugins: HARNESS_PLUGINS_MIN });
  const capture = installImapFlowOptionsCapture();
  const client = createImapFlowClient(baseHarnessAccount(imap.port, mailDir), HARNESS_PASSWORD);
  try {
    await client.connect();
    assert.ok(capture.options);
    assert.equal(capture.options.maxIdleTime, IDLE_REFRESH_MS);
    assert.equal(capture.options.disableAutoIdle, true);
    assert.equal(Object.prototype.hasOwnProperty.call(capture.options, 'socketTimeout'), false);
    await client.logout();
  } finally {
    capture.restore();
    await imap.close();
  }
});

test('AC10: keepalive release fetches nothing; cancelled idle ineligible', serial, async () => {
  const mailDir = tempDir('snail-h-kp-');
  const imap = await startHarnessServer();
  const fr14 = createHarnessSleeper({ holdWebhookAttempt: true });
  let posts = 0;
  const hook = http.createServer((_req, res) => {
    posts += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const sup = await runHarnessSupervisor(fr14, {
    accounts: [
      baseHarnessAccount(imap.port, mailDir, {
        webhook_url: `http://127.0.0.1:${hookPort}/hook`,
      }),
    ],
  });
  await waitFor(() => imap.control.sessions().some((s) => s.state === 'Selected'));
  fr14.releaseKeepalive();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(posts, 0);
  assert.equal(fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length, 0);
  imap.control.addMessage('INBOX', { raw: buildRawMessage({ subject: 'after-keepalive' }) });
  await waitFor(() => posts === 1);
  await stopHarness(sup, fr14);
  hook.close();
  await imap.close();
});
