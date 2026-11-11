'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  decideConfigReload,
  rereadSnailConfig,
  diffAccountRows,
  RELOAD_REJECT_PREFIX,
} = require('../src/config-reload.js');
const { parseSnailConfig, loadSnailConfig } = require('../src/config.js');
const { startConfigWatch } = require('../src/config-watch.js');
const { startSupervisor, createFakeImapClient } = require('../src/supervisor.js');
const { REQUEST_POLL_MS } = require('../src/notify-delivery.js');

const serial = { concurrency: 1 };

function configReloadSleeper() {
  return async (ms) => {
    if (ms === REQUEST_POLL_MS) {
      return new Promise(() => {});
    }
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeConfig(dir, body, mode = 0o600) {
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, body, { mode });
  return file;
}

const PLANTED = 'PLANTED-SECRET-XYZZY-99';

function accountBlock(name, mailDir, password = 'inline-pass', host = 'imap.example.com') {
  return `
[[account]]
name = "${name}"
host = "${host}"
user = "you@example.com"
password = "${password}"
mailbox = "INBOX"
mail_dir = "${mailDir}"
notifier = "webhook"
webhook_url = "http://127.0.0.1:9/hook"
webhook_secret = "hook-secret"
`;
}

function twoAccountToml(mailA, mailB, extraComment = '') {
  return `${extraComment}${accountBlock('alpha', mailA)}${accountBlock('beta', mailB)}`;
}

function inlineResolver(resolveCounts) {
  return {
    resolve: async (v) => {
      if (resolveCounts) resolveCounts.push(v);
      return v;
    },
    clearCache: () => {},
  };
}

test('AC12: identical rewrite is unchanged', () => {
  const mailA = '/tmp/a';
  const mailB = '/tmp/b';
  const body = twoAccountToml(mailA, mailB);
  const cur = parseSnailConfig(body);
  assert.equal(cur.ok, true);
  const again = parseSnailConfig(`${body}\n# comment only\n`);
  assert.equal(again.ok, true);
  const decision = decideConfigReload(cur.config, { ok: true, config: again.config });
  assert.equal(decision.kind, 'unchanged');
});

test('AC12: rejected reload keeps reason and redacts planted secret', () => {
  const mailA = tempDir('snail-ra-');
  const mailB = tempDir('snail-rb-');
  const cur = parseSnailConfig(twoAccountToml(mailA, mailB));
  assert.equal(cur.ok, true);
  const badParsed = parseSnailConfig(`
[[account]]
name = "only"
host = "h"
user = "u"
password = "${PLANTED}"
mail_dir = "/m"
notifier = "webhook"
webhook_url = "http://127.0.0.1:9/h"
`);
  assert.equal(badParsed.ok, false);
  const decision = decideConfigReload(cur.config, badParsed, [], [PLANTED]);
  assert.equal(decision.kind, 'keepAndLog');
  assert.doesNotMatch(decision.logLine, new RegExp(PLANTED));
  assert.match(decision.logLine, /missing webhook_secret/);
});

test('AC12: mode 0644 on reload rejects without exiting', () => {
  const dir = tempDir('snail-cfg-');
  const mailA = tempDir('snail-ma-');
  const mailB = tempDir('snail-mb-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  fs.chmodSync(file, 0o644);
  const decision = decideConfigReload(loaded.config, rereadSnailConfig(file));
  assert.equal(decision.kind, 'keepAndLog');
  assert.match(decision.logLine, /config permissions too open/);
});

test('AC12: deleting last account is rejected reload', () => {
  const mailA = tempDir('snail-la-');
  const mailB = tempDir('snail-lb-');
  const cur = parseSnailConfig(twoAccountToml(mailA, mailB));
  const empty = parseSnailConfig('text_limit = 1\n');
  const decision = decideConfigReload(cur.config, empty);
  assert.equal(decision.kind, 'keepAndLog');
  assert.match(decision.logLine, /missing account/);
});

test('AC11: diff detects add change remove', () => {
  const mailA = '/a';
  const mailB = '/b';
  const mailC = '/c';
  const cur = parseSnailConfig(twoAccountToml(mailA, mailB)).config;
  const updated = parseSnailConfig(
    `${accountBlock('alpha', mailA, 'new-pass')}${accountBlock('gamma', mailC)}`
  ).config;
  const diff = diffAccountRows(cur, updated);
  assert.deepEqual(diff.removed, ['beta']);
  assert.equal(diff.added[0].name, 'gamma');
  assert.equal(diff.changed[0].name, 'alpha');
});

test('AC11: comment-only save does not reconnect', serial, async () => {
  const dir = tempDir('snail-rel-');
  const mailA = tempDir('snail-ca-');
  const mailB = tempDir('snail-cb-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  const logs = [];
  const imapA = createFakeImapClient({ id: 'alpha-id', uidNext: 2 });
  const imapB = createFakeImapClient({ id: 'beta-id', uidNext: 2 });
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: (line) => logs.push(line),
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => (acct.name === 'alpha' ? imapA : imapB),
    secretResolverFactory: () => inlineResolver(),
  });
  fs.writeFileSync(file, `${twoAccountToml(mailA, mailB)}\n# touch\n`, { mode: 0o600 });
  sup.reloadNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(imapA.id, 'alpha-id');
  assert.equal(imapB.id, 'beta-id');
  assert.ok(!logs.some((l) => l.includes('config reloaded')));
  await sup.stopAndWait();
});

test('AC11: adding account starts only the new loop', serial, async () => {
  const dir = tempDir('snail-add-');
  const mailA = tempDir('snail-aa-');
  const mailC = tempDir('snail-ac-');
  const file = writeConfig(dir, accountBlock('solo', mailA));
  const loaded = loadSnailConfig(file);
  const imapSolo = createFakeImapClient({ id: 'solo-id', uidNext: 2 });
  const imapNew = createFakeImapClient({ id: 'new-id', uidNext: 2 });
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: () => {},
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => (acct.name === 'solo' ? imapSolo : imapNew),
    secretResolverFactory: () => inlineResolver(),
  });
  fs.writeFileSync(file, `${accountBlock('solo', mailA)}${accountBlock('extra', mailC)}`, { mode: 0o600 });
  sup.reloadNow();
  await waitFor(() => sup.getRunners().has('extra'), 2000);
  assert.equal(imapSolo.id, 'solo-id');
  await sup.stopAndWait();
});

test('AC11: changed secret string restarts only that account', serial, async () => {
  const dir = tempDir('snail-chg-');
  const mailA = tempDir('snail-da-');
  const mailB = tempDir('snail-db-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  const resolveAlpha = [];
  const resolveBeta = [];
  let alphaGen = 0;
  let alphaClient = createFakeImapClient({ id: `alpha-${++alphaGen}`, uidNext: 2 });
  const betaClient = createFakeImapClient({ id: 'beta-stable', uidNext: 2 });
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: () => {},
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => {
      if (acct.name === 'alpha') {
        alphaClient = createFakeImapClient({ id: `alpha-${++alphaGen}`, uidNext: 2 });
        return alphaClient;
      }
      return betaClient;
    },
    secretResolverFactory: (acct) =>
      inlineResolver(acct.name === 'alpha' ? resolveAlpha : resolveBeta),
  });
  fs.writeFileSync(
    file,
    `${accountBlock('alpha', mailA, 'rotated-password')}${accountBlock('beta', mailB)}`,
    { mode: 0o600 }
  );
  sup.reloadNow();
  await waitFor(() => resolveAlpha.length >= 2, 2000);
  assert.equal(betaClient.id, 'beta-stable');
  await sup.stopAndWait();
});

test('config reloaded is logged before other account reconnects', serial, async () => {
  const dir = tempDir('snail-order-');
  const mailA = tempDir('snail-oa-');
  const mailB = tempDir('snail-ob-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  const logs = [];
  const factoryCalls = { alpha: 0, beta: 0 };
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: (line) => logs.push(line),
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => {
      factoryCalls[acct.name] += 1;
      return createFakeImapClient({ id: `${acct.name}-${factoryCalls[acct.name]}`, uidNext: 2 });
    },
    secretResolverFactory: () => inlineResolver(),
  });
  fs.writeFileSync(
    file,
    `${accountBlock('alpha', mailA, 'rotated')}${accountBlock('beta', mailB)}`,
    { mode: 0o600 }
  );
  sup.reloadNow();
  await waitFor(() => logs.some((l) => l.includes('config reloaded')), 2000);
  assert.equal(factoryCalls.beta, 1);
  await waitFor(() => factoryCalls.alpha >= 2, 2000);
  await sup.stopAndWait();
});

test('AC11: removing one account does not logout the other', serial, async () => {
  const dir = tempDir('snail-rem-');
  const mailA = tempDir('snail-ra2-');
  const mailB = tempDir('snail-rb2-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  const imapAlpha = createFakeImapClient({ id: 'alpha-keep', uidNext: 2 });
  const imapBeta = createFakeImapClient({ id: 'beta-drop', uidNext: 2 });
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: () => {},
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => (acct.name === 'alpha' ? imapAlpha : imapBeta),
    secretResolverFactory: () => inlineResolver(),
  });
  fs.writeFileSync(file, accountBlock('alpha', mailA), { mode: 0o600 });
  sup.reloadNow();
  await waitFor(() => !sup.getRunners().has('beta'), 2000);
  assert.equal(imapAlpha.id, 'alpha-keep');
  await sup.stopAndWait();
});

test('fs.watch triggers reread on config write', serial, async () => {
  const dir = tempDir('snail-watch-');
  const mailA = tempDir('snail-wa-');
  const file = writeConfig(dir, accountBlock('solo', mailA));
  let events = 0;
  const watch = startConfigWatch({
    configPath: file,
    enableReload: false,
    onEvent: () => {
      events += 1;
    },
  });
  fs.writeFileSync(file, accountBlock('solo', mailA, 'inline-pass', 'imap2.example.com'), { mode: 0o600 });
  await waitFor(() => events >= 1, 3000);
  watch.close();
});

test('supervisor reload applies a watch-driven config write', serial, async () => {
  const dir = tempDir('snail-watch-sup-');
  const mailA = tempDir('snail-ws-');
  const file = writeConfig(dir, accountBlock('solo', mailA));
  const loaded = loadSnailConfig(file);
  const logs = [];
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    stopAfterSync: true,
    log: (line) => logs.push(line),
    sleeper: configReloadSleeper(),
    imapFactory: () => createFakeImapClient({ id: 'solo', uidNext: 2 }),
    secretResolverFactory: () => inlineResolver(),
  });
  fs.writeFileSync(file, accountBlock('solo', mailA, 'inline-pass', 'imap2.example.com'), { mode: 0o600 });
  await waitFor(() => logs.some((l) => l.includes('config reloaded')), 3000);
  await sup.stopAndWait();
});

test('config watch ignores other filenames', () => {
  const dir = tempDir('snail-cw-');
  const file = writeConfig(dir, accountBlock('solo', tempDir('m-')));
  let events = 0;
  const watch = startConfigWatch({
    configPath: file,
    enableReload: false,
    onEvent: () => {
      events += 1;
    },
  });
  fs.writeFileSync(path.join(dir, 'other.toml'), 'x', { mode: 0o600 });
  watch.close();
  assert.equal(events, 0);
});

test('reload io error omits OS text', () => {
  const dir = tempDir('snail-io-');
  const file = path.join(dir, 'config.toml');
  const cur = parseSnailConfig(accountBlock('a', tempDir('m-'))).config;
  const decision = decideConfigReload(cur, rereadSnailConfig(file));
  assert.equal(decision.logLine, `${RELOAD_REJECT_PREFIX}config io error`);
});

test('hung logout on removed account does not block other save', serial, async () => {
  const dir = tempDir('snail-hang-');
  const mailA = tempDir('snail-ha-');
  const mailB = tempDir('snail-hb-');
  const file = writeConfig(dir, twoAccountToml(mailA, mailB));
  const loaded = loadSnailConfig(file);
  const imapAlpha = createFakeImapClient({
    id: 'alpha-save',
    uidNext: 102,
    uidValidity: 1,
    messages: {
      101: { body: 'x', subject: 'S', from: [{ address: 'a@example.com' }] },
    },
  });
  const imapBeta = createFakeImapClient({
    id: 'beta-hang',
    uidNext: 2,
    hangLogout: true,
  });
  const fetchImpl = async () => new Response('', { status: 200 });
  const sup = await startSupervisor({
    config: loaded.config,
    configPath: file,
    enableReload: false,
    stopAfterSync: true,
    log: () => {},
    sleeper: configReloadSleeper(),
    imapFactory: (acct) => (acct.name === 'alpha' ? imapAlpha : imapBeta),
    secretResolverFactory: () => inlineResolver(),
    fetchImpl,
  });
  try {
    await waitFor(
      () => fs.readdirSync(mailA).some((n) => n.endsWith('.json') && !n.includes('state')),
      2000
    );
    fs.writeFileSync(file, accountBlock('alpha', mailA), { mode: 0o600 });
    sup.reloadNow();
    await waitFor(
      () => fs.readdirSync(mailA).some((n) => n.endsWith('.json') && !n.includes('state')),
      2000
    );
    await waitFor(() => {
      imapBeta.releaseLogout();
      return !sup.getRunners().has('beta');
    }, 2000);
  } finally {
    imapBeta.releaseLogout();
    await sup.stopAndWait();
  }
});

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timeout');
}
