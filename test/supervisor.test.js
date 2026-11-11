'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const {
  IDLE_KEEPALIVE_MS,
  coerceImapInteger,
  removeLeftoverTmpFiles,
  uidsToSync,
  runAccountLoop,
  startSupervisor,
  createFakeImapClient,
  formatLogLine,
  raceIdle,
} = require('../src/supervisor.js');
const { readSnailState, initialSnailState } = require('../src/mail-store.js');
const { parseCli, assertCleanArgv, readBuildStamp } = require('../snail.js');
const { NOTIFY_RETRY_DELAYS_MS } = require('../src/notifiers/retry.js');
const { buildWebhookBody, WEBHOOK_ATTEMPT_TIMEOUT_MS } = require('../src/notifiers/webhook.js');
const { REQUEST_POLL_MS } = require('../src/notify-delivery.js');
const { NOTIFY_DELAY_MS } = require('../src/notify-ledger.js');

const root = path.join(__dirname, '..');
const snailPath = path.join(root, 'snail.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function instantSleeper(delays) {
  return async (ms) => {
    if (ms === REQUEST_POLL_MS) {
      return new Promise(() => {});
    }
    if (delays) {
      delays.push(ms);
    }
  };
}

function webhookFriendlySleeper(delays) {
  return async (ms) => {
    if (ms === WEBHOOK_ATTEMPT_TIMEOUT_MS || ms === REQUEST_POLL_MS) {
      return new Promise(() => {});
    }
    if (NOTIFY_DELAY_MS.includes(ms) || ms === 60000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (delays) {
      delays.push(ms);
    }
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timeout');
}

async function stopLoops(stopSignal, ...promises) {
  stopSignal.stopped = true;
  await Promise.all(promises);
}

/**
 * @param {Partial<ReturnType<typeof baseAccount>>} overrides
 */
function baseAccount(overrides = {}) {
  const mail_dir = overrides.mail_dir ?? tempDir('snail-mail-');
  return {
    name: 'work',
    nameLine: 1,
    host: 'imap.example.com',
    port: 993,
    tls: 'on',
    user: 'you@example.com',
    password: 'inline-mail-pass',
    mailbox: 'INBOX',
    mail_dir,
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
    ...overrides,
  };
}

function inlineResolver() {
  return {
    resolve: async (v) => v,
    clearCache: () => {},
  };
}

test('AC3: coerceImapInteger maps safe BigInt, keeps numbers, rejects unsafe BigInt', () => {
  assert.equal(coerceImapInteger(12), 12);
  assert.equal(coerceImapInteger(99n), 99);
  assert.throws(() => coerceImapInteger(2n ** 53n + 1n), /safe integer/);
});

test('AC1 AC2: fake client BigInt mailbox writes numeric state, message, and webhook', async () => {
  const mailDir = tempDir('snail-bigint-');
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 7,
      notifyBoundary: 100,
      backlogUid: 0,
      lastUid: 99,
    }),
    { mode: 0o600 },
  );
  /** @type {Record<string, unknown> | null} */
  let webhookPayload = null;
  const imap = createFakeImapClient({
    uidNext: 101n,
    uidValidity: 7n,
    messages: {
      100: {
        body: 'hello',
        subject: 'Subj',
        from: [{ address: 'ada@example.com' }],
        modseq: 999999999999n,
      },
    },
  });
  const fetchImpl = async (_url, init) => {
    webhookPayload = JSON.parse(String(init?.body));
    return new Response('', { status: 200 });
  };
  const stopSignal = { stopped: false };
  const loop = runAccountLoop({
    account: baseAccount({ mail_dir: mailDir }),
    secrets: inlineResolver(),
    imapFactory: () => imap,
    log: () => {},
    fetchImpl,
    stopSignal,
    sleeper: webhookFriendlySleeper([]),
    stopAfterSync: true,
  });

  await waitFor(() => readSnailState(mailDir) !== null);
  await waitFor(() => webhookPayload !== null);
  await stopLoops(stopSignal, loop);

  const state = readSnailState(mailDir);
  assert.ok(state);
  for (const key of ['uidValidity', 'notifyBoundary', 'backlogUid', 'lastUid']) {
    assert.equal(typeof state[key], 'number', key);
  }
  assert.equal(state.uidValidity, 7);

  const msgFiles = fs
    .readdirSync(mailDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.equal(msgFiles.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(mailDir, msgFiles[0]), 'utf8'));
  assert.equal(typeof saved.uid, 'number');
  assert.equal(typeof saved.uid_validity, 'number');
  assert.equal(saved.uid, 100);
  assert.equal(saved.uid_validity, 7);
  assert.ok(!('modseq' in saved));

  assert.ok(webhookPayload);
  assert.equal(typeof webhookPayload.uid, 'number');
  assert.equal(typeof webhookPayload.uid_validity, 'number');
  assert.ok(!('modseq' in webhookPayload));
});

test('removeLeftoverTmpFiles deletes planted tmp files', () => {
  const mailDir = tempDir('snail-tmp-');
  const keep = path.join(mailDir, '20260101T120000Z_1_0000000001.json');
  const tmp = path.join(mailDir, '20260101T120000Z_1_0000000001.json.tmp-1234-deadbeef');
  fs.writeFileSync(keep, '{}', { mode: 0o600 });
  fs.writeFileSync(tmp, '{}', { mode: 0o600 });
  removeLeftoverTmpFiles(mailDir);
  assert.ok(fs.existsSync(keep));
  assert.ok(!fs.existsSync(tmp));
});

test('uidsToSync merges backlog and catch-up ranges', () => {
  const state = {
    uidValidity: 1,
    notifyBoundary: 100,
    backlogUid: 5,
    lastUid: 99,
  };
  const uids = uidsToSync(state, 110);
  assert.deepEqual(uids, Array.from({ length: 104 }, (_, i) => i + 6));
});

test('AC3: hung connect on one account does not block the other', async () => {
  const delays = [];
  const sleeper = instantSleeper(delays);
  const mailA = tempDir('snail-a-');
  const mailB = tempDir('snail-b-');
  const stopSignal = { stopped: false };
  const imapA = createFakeImapClient({
    id: 'a',
    hangConnect: true,
    isStopped: () => stopSignal.stopped,
    sleeper,
  });
  const imapB = createFakeImapClient({
    id: 'b',
    uidNext: 101,
    uidValidity: 1,
    messages: {
      100: { body: 'new', subject: 'Hi', from: [{ address: 'a@example.com' }] },
    },
  });

  const fetchImpl = async () => new Response('', { status: 200 });

  const slow = runAccountLoop({
    account: baseAccount({ name: 'slow', mail_dir: mailA }),
    secrets: inlineResolver(),
    imapFactory: () => imapA,
    log: () => {},
    sleeper,
    stopSignal,
  });
  const fast = runAccountLoop({
    account: baseAccount({ name: 'fast', mail_dir: mailB }),
    secrets: inlineResolver(),
    imapFactory: () => imapB,
    log: () => {},
    sleeper,
    fetchImpl,
    stopSignal,
    stopAfterSync: true,
  });

  await waitFor(() => readSnailState(mailB)?.lastUid === 100);
  await stopLoops(stopSignal, slow, fast);
  assert.ok(readSnailState(mailB));
  assert.ok(delays.length < 50);
});

test('AC3: two OpenClaw accounts use separate gateway connections', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  after(() => wss.close());
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.send(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'connect') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, method: 'connect' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', reject);
  });
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const gatewayUrl = `http://127.0.0.1:${port}`;

  const mailA = tempDir('snail-oa-');
  const mailB = tempDir('snail-ob-');
  const stopSignal = { stopped: false };
  const imapA = createFakeImapClient({ id: 'oa', uidNext: 10, messages: {} });
  const imapB = createFakeImapClient({ id: 'ob', uidNext: 10, messages: {} });

  const pA = runAccountLoop({
    account: baseAccount({
      name: 'a',
      mail_dir: mailA,
      notifier: 'openclaw',
      openclaw_url: gatewayUrl,
      openclaw_token: 'token-a',
    }),
    secrets: inlineResolver(),
    imapFactory: () => imapA,
    log: () => {},
    stopSignal,
    stopAfterSync: true,
  });
  const pB = runAccountLoop({
    account: baseAccount({
      name: 'b',
      mail_dir: mailB,
      notifier: 'openclaw',
      openclaw_url: gatewayUrl,
      openclaw_token: 'token-b',
    }),
    secrets: inlineResolver(),
    imapFactory: () => imapB,
    log: () => {},
    stopSignal,
    stopAfterSync: true,
  });

  await Promise.race([
    Promise.all([pA, pB]),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  assert.equal(connections, 2);
  await stopLoops(stopSignal, pA, pB);
});

test('AC4: later run fetches backlog and new mail with correct wake behavior', async () => {
  const mailDir = tempDir('snail-ac4-');
  fs.mkdirSync(mailDir, { recursive: true });
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 5,
      notifyBoundary: 100,
      backlogUid: 10,
      lastUid: 105,
    }),
    { mode: 0o600 }
  );

  const lines = [];
  const imap = createFakeImapClient({
    uidValidity: 5,
    uidNext: 110,
    messages: {
      11: { body: 'backlog', from: [{ address: 'b@example.com' }] },
      106: { body: 'down', from: [{ address: 'n@example.com' }] },
    },
  });

  const fetchImpl = async () => new Response('', { status: 200 });
  const stopSignal = { stopped: false };

  const loop = runAccountLoop({
    account: baseAccount({ mail_dir: mailDir }),
    secrets: inlineResolver(),
    imapFactory: () => imap,
    log: (line) => lines.push(line),
    fetchImpl,
    stopSignal,
    sleeper: webhookFriendlySleeper([]),
    stopAfterSync: true,
  });

  await waitFor(() => readSnailState(mailDir)?.lastUid === 106);
  await stopLoops(stopSignal, loop);

  assert.ok(!lines.some((l) => l.includes('notify ok') && l.includes('uid 11')));
  assert.ok(lines.some((l) => l.includes('notify ok') && l.includes('106')));
  const state = readSnailState(mailDir);
  assert.equal(state.backlogUid, 11);
  assert.equal(state.lastUid, 106);
  const backlogFiles = fs.readdirSync(mailDir).filter((f) => f.includes('_0000000011.json'));
  assert.equal(backlogFiles.length, 1);
});

test('AC4: UIDVALIDITY change resets state before bodies', async () => {
  const mailDir = tempDir('snail-resync-');
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 50,
      backlogUid: 10,
      lastUid: 60,
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(mailDir, 'old_1_0000000020.json'), '{"uid":20}', { mode: 0o600 });

  const imap = createFakeImapClient({
    uidValidity: 2,
    uidNext: 52,
    messages: {
      1: { body: 'resync', from: [{ address: 'x@example.com' }] },
    },
  });

  const stopSignal = { stopped: false };
  const loop = runAccountLoop({
    account: baseAccount({ mail_dir: mailDir }),
    secrets: inlineResolver(),
    imapFactory: () => imap,
    log: () => {},
    fetchImpl: async () => new Response('', { status: 200 }),
    stopSignal,
    sleeper: instantSleeper([]),
    stopAfterSync: true,
  });
  await waitFor(() => readSnailState(mailDir)?.uidValidity === 2);
  await stopLoops(stopSignal, loop);

  const state = readSnailState(mailDir);
  assert.equal(state.uidValidity, 2);
  assert.equal(state.notifyBoundary, 52);
  assert.equal(state.lastUid, 51);
  assert.equal(state.backlogUid, 1);
  assert.ok(fs.existsSync(path.join(mailDir, 'old_1_0000000020.json')));
});

test('AC9: failing webhook leaves one file, advances lastUid, logs notify failed', async () => {
  const mailDir = tempDir('snail-ac9-');
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 100,
      backlogUid: 0,
      lastUid: 99,
    }),
    { mode: 0o600 }
  );
  const lines = [];
  const imap = createFakeImapClient({
    uidNext: 101,
    uidValidity: 1,
    messages: {
      100: {
        body: 'body',
        subject: 'Subj',
        from: [{ address: 'ada@example.com' }],
      },
    },
  });
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response('', { status: 500 });
  };
  const delays = [];
  const stopSignal = { stopped: false };

  const loop = runAccountLoop({
    account: baseAccount({ mail_dir: mailDir }),
    secrets: inlineResolver(),
    imapFactory: () => imap,
    log: (line) => lines.push(line),
    fetchImpl,
    sleeper: webhookFriendlySleeper(delays),
    stopSignal,
    stopAfterSync: true,
  });

  await waitFor(() => lines.some((l) => l.includes('notify failed')));
  await stopLoops(stopSignal, loop);

  const files = fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.equal(files.length, 1);
  assert.equal(readSnailState(mailDir).lastUid, 100);
  assert.ok(lines.some((l) => l.includes('notify failed') && l.includes('100')));
  assert.equal(fetchCount, 1);
  const ledger = JSON.parse(
    fs.readFileSync(path.join(mailDir, '.snail-notify.json'), 'utf8')
  );
  assert.equal(ledger.items.length, 1);
  assert.match(
    lines.find((l) => l.includes('notify failed') && l.includes('100')),
      /status 500/
  );

  const secondPass = createFakeImapClient({
    uidNext: 101,
    uidValidity: 1,
    messages: { 100: { body: 'body' } },
  });
  const store = require('../src/mail-store.js').createMailStore({
    mailDir,
    textLimit: 10000,
    htmlLimit: 100000,
    attachmentLimit: 10485760,
  });
  const existing = store.lookupExistingMessageFile(1, 100);
  assert.ok(existing);
});

test('AC16: failed imap connects use FR6 backoff per account', async () => {
  const delays = [];
  let backoff = 5000;
  const sleeper = async (ms) => {
    delays.push(ms);
  };
  for (let i = 0; i < 5; i++) {
    await sleeper(backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000]);
});

test('AC17: full disk on one account leaves checkpoint; other account still saves', async () => {
  const mailA = tempDir('snail-disk-a-');
  const mailB = tempDir('snail-disk-b-');
  let failA = true;
  const wrapFsFor = (mailDir, shouldFail) => ({
    ...fs,
    writeFileSync(file, data, opts) {
      const isMsgTmp =
        shouldFail() &&
        String(file).includes('.tmp-') &&
        typeof data === 'string' &&
        data.includes('"uid"') &&
        !String(file).includes('.snail-state');
      if (isMsgTmp) {
        const err = new Error('ENOSPC');
        err.code = 'ENOSPC';
        throw err;
      }
      return fs.writeFileSync(file, data, opts);
    },
    readFileSync: fs.readFileSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  });

  const imapA = createFakeImapClient({
    uidNext: 20,
    messages: { 1: { body: 'blocked' } },
  });
  const imapB = createFakeImapClient({
    uidNext: 101,
    messages: { 100: { body: 'ok', from: [{ address: 'b@example.com' }] } },
  });

  const stopSignal = { stopped: false };
  const runA = runAccountLoop({
    account: baseAccount({ name: 'a', mail_dir: mailA }),
    secrets: inlineResolver(),
    imapFactory: () => imapA,
    fs: wrapFsFor(mailA, () => failA),
    log: () => {},
    fetchImpl: async () => new Response('', { status: 200 }),
    stopSignal,
    sleeper: webhookFriendlySleeper([]),
    stopAfterSync: true,
  });
  const runB = runAccountLoop({
    account: baseAccount({ name: 'b', mail_dir: mailB }),
    secrets: inlineResolver(),
    imapFactory: () => imapB,
    log: () => {},
    fetchImpl: async () => new Response('', { status: 200 }),
    stopSignal,
    sleeper: webhookFriendlySleeper([]),
    stopAfterSync: true,
  });

  await waitFor(() => fs.readdirSync(mailB).some((f) => f.includes('_0000000100.json')));
  await stopLoops(stopSignal, runA, runB);
  failA = false;
  assert.equal(readSnailState(mailA).backlogUid, 0);
  assert.ok(fs.readdirSync(mailB).some((f) => f.includes('_0000000100.json')));
});

test('29-minute idle keepalive re-enters without fetch', async () => {
  const imap = createFakeImapClient({ uidNext: 10, messages: {} });
  let fetchCalls = 0;
  const origFetch = imap.fetchOne.bind(imap);
  imap.fetchOne = async (uid) => {
    fetchCalls += 1;
    return origFetch(uid);
  };

  let nowMs = 0;
  const stopSignal = { stopped: false };
  for (let i = 0; i < 3; i += 1) {
    const result = await raceIdle(
      imap,
      100,
      nowMs,
      () => nowMs,
      async (ms) => {
        nowMs += ms;
      },
      stopSignal
    );
    assert.equal(result, 'keepalive');
    imap.cancelIdle();
  }
  assert.equal(fetchCalls, 0);
  assert.equal(nowMs, 300);
  assert.equal(IDLE_KEEPALIVE_MS, 29 * 60 * 1000);
});

test('AC10: planted secret and auth header absent from logs', async () => {
  const planted = 'PLANT-SECRET-XYZZY-99';
  const mailDir = tempDir('snail-redact-');
  fs.writeFileSync(
    path.join(mailDir, '.snail-state.json'),
    JSON.stringify({
      uidValidity: 1,
      notifyBoundary: 100,
      backlogUid: 0,
      lastUid: 99,
    }),
    { mode: 0o600 }
  );
  const lines = [];
  const imap = createFakeImapClient({
    uidNext: 101,
    messages: {
      100: { body: 'x', from: [{ address: 'a@example.com' }], subject: 'S' },
    },
  });
  const fetchImpl = async (_url, init) => {
    assert.ok(String(init.headers.Authorization).startsWith('Bearer '));
    return new Response('', { status: 200 });
  };
  const stopSignal = { stopped: false };

  const loop = runAccountLoop({
    account: baseAccount({
      mail_dir: mailDir,
      webhook_secret: planted,
      password: planted,
    }),
    secrets: inlineResolver(),
    imapFactory: () => imap,
    log: (line) => lines.push(line),
    fetchImpl,
    stopSignal,
    sleeper: webhookFriendlySleeper([]),
    stopAfterSync: true,
  });

  await waitFor(() => lines.some((l) => l.includes('notify ok')));
  await stopLoops(stopSignal, loop);

  const joined = lines.join('\n');
  assert.doesNotMatch(joined, new RegExp(planted));
  const msgFiles = fs.readdirSync(mailDir).filter((f) => f.endsWith('.json') && f !== '.snail-state.json');
  for (const f of msgFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(mailDir, f), 'utf8'), new RegExp(planted));
  }
  const stateRaw = fs.readFileSync(path.join(mailDir, '.snail-state.json'), 'utf8');
  assert.doesNotMatch(stateRaw, new RegExp(planted));
});

test('parseCli rejects unknown flags with usage', () => {
  assert.deepEqual(parseCli(['node', 'snail.js', 'positional']), { kind: 'usage' });
});

test('assertCleanArgv accepts only node script --config abs path', () => {
  const configPath = path.join(tempDir('snail-argv-'), 'config.toml');
  fs.writeFileSync(configPath, '# empty\n', { mode: 0o600 });
  const saved = [...process.argv];
  process.argv = [process.execPath, snailPath, '--config', configPath];
  assert.doesNotThrow(() => assertCleanArgv(configPath));
  process.argv = saved;
});

test('build --version lines match build stamp', () => {
  const ver = 'v0.0.0-phase5';
  const build = spawnSync('bash', [path.join(root, 'scripts', 'build.sh')], {
    cwd: root,
    env: { ...process.env, VERSION: ver },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const tarball = path.join(root, 'dist', `snail-${ver}.tar.gz`);
  const prefix = `snail-${ver}/`;
  const stampRaw = execFileSync('tar', ['xOf', tarball, `${prefix}build-stamp.json`], {
    encoding: 'utf8',
  });
  fs.writeFileSync(path.join(root, 'build-stamp.json'), stampRaw);

  const short = spawnSync(process.execPath, [snailPath, '--version'], { encoding: 'utf8' });
  assert.equal(short.status, 0);
  const stamp = JSON.parse(stampRaw);
  assert.equal(short.stdout.trim(), `snail ${stamp.version} (${String(stamp.commitSHA).slice(0, 12)})`);

  const verbose = spawnSync(process.execPath, [snailPath, '--version', '--verbose'], {
    encoding: 'utf8',
  });
  assert.equal(verbose.status, 0);
  assert.equal(
    verbose.stdout.trim(),
    `snail ${stamp.version} (${stamp.commitSHA}) built ${stamp.buildTimestamp}`
  );

  try {
    fs.unlinkSync(path.join(root, 'build-stamp.json'));
  } catch {
    /* ignore */
  }
});

test('formatLogLine uses UTC prefix and account tag', () => {
  const line = formatLogLine('work', 'hello', []);
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[snail\] \[work\] hello$/);
});

test('webhook payload builder still omits forbidden keys in supervisor path', () => {
  const body = buildWebhookBody({
    account: 'work',
    from: 'a@example.com',
    subject: 'S',
    date: '2026-11-01T03:15:00.000Z',
    message_id: '',
    path: '/abs/x.json',
    mailbox: 'INBOX',
    uid: 1,
    uid_validity: 1,
    notify_id: 'work/1/1',
  });
  assert.equal(Object.keys(body).length, 10);
});
