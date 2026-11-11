'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { runNotifyList } = require('../src/notify-cli.js');
const { upsertNotifyItem, isoFromMs, upsertLedgerRetryItem } = require('../src/notify-ledger.js');
const { persistInitialSnailState } = require('../src/mail-store.js');
const { loadSnailConfig } = require('../src/config.js');

const root = path.join(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snail-ncli-'));
}

function accountToml(name, mailDir) {
  return `
[[account]]
name = "${name}"
host = "imap.example.com"
port = 993
tls = "on"
user = "you@example.com"
password = "inline:pw"
mailbox = "INBOX"
mail_dir = "${mailDir.replace(/\\/g, '/')}"
notifier = "webhook"
webhook_url = "http://127.0.0.1:9/hook"
webhook_secret = "hook-secret"
`;
}

function writeConfig(dir, body) {
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, body, { mode: 0o600 });
  return p;
}

test('notify-list exits 0 when no rows', () => {
  const mailDir = tempDir();
  persistInitialSnailState(mailDir, 1, 100);
  const cfgPath = writeConfig(tempDir(), accountToml('work', mailDir));
  const loaded = loadSnailConfig(cfgPath);
  assert.equal(loaded.ok, true);
  let exitCode = 99;
  const orig = process.exit;
  process.exit = (c) => {
    exitCode = c;
    throw new Error('exit');
  };
  try {
    runNotifyList(loaded.config);
  } catch {
    /* expected */
  } finally {
    process.exit = orig;
  }
  assert.equal(exitCode, 0);
});

test('notify-list shows retry-queue row as state ledger', () => {
  const mailDir = tempDir();
  persistInitialSnailState(mailDir, 1, 100);
  upsertLedgerRetryItem(
    mailDir,
    {
      notify_id: 'work/1/10',
      account: 'work',
      uid: 10,
      uid_validity: 1,
      file: 'f.json',
      attempts: 0,
      last_status: 'none',
      next_attempt_at: isoFromMs(0),
    },
    0
  );
  const cfgPath = writeConfig(tempDir(), accountToml('work', mailDir));
  const loaded = loadSnailConfig(cfgPath);
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (c) => {
    exitCode = c;
    throw new Error('exit');
  };
  try {
    runNotifyList(loaded.config);
  } catch {
    /* exit */
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.includes('state ledger') && l.includes('uid 10')));
});

test('AC7: notify-list omits planted secret from stdout stderr and ledger', () => {
  const secret = 'planted-list-secret';
  const mailDir = tempDir();
  persistInitialSnailState(mailDir, 1, 100);
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/7',
    account: 'work',
    uid: 7,
    uid_validity: 1,
    file: 'x.json',
    attempts: 1,
    last_status: '500',
    next_attempt_at: isoFromMs(0),
    request_id: 'req-7',
  });
  const toml = accountToml('work', mailDir).replace('hook-secret', secret);
  const cfgPath = writeConfig(tempDir(), toml);
  const ledgerText = fs.readFileSync(path.join(mailDir, '.snail-notify.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(root, 'snail.js'), 'notify-list', '--config', cfgPath], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(secret));
  assert.ok(!r.stderr.includes(secret));
  assert.ok(!ledgerText.includes(secret));
});

test('AC7: notify-list does not use child_process', () => {
  const src = fs.readFileSync(path.join(root, 'src/notify-cli.js'), 'utf8');
  assert.ok(!src.includes('child_process'));
  assert.ok(!src.includes('execFile'));
});

test('notify-list stdout omits webhook secret', () => {
  const mailDir = tempDir();
  persistInitialSnailState(mailDir, 1, 100);
  upsertNotifyItem(mailDir, {
    notify_id: 'work/1/5',
    account: 'work',
    uid: 5,
    uid_validity: 1,
    file: 'x.json',
    attempts: 1,
    last_status: '500',
    next_attempt_at: isoFromMs(0),
    request_id: 'req-1',
  });
  const cfgPath = writeConfig(tempDir(), accountToml('work', mailDir));
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(root, 'snail.js'), 'notify-list', '--config', cfgPath], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('uid 5'));
  assert.ok(!r.stdout.includes('hook-secret'));
});
