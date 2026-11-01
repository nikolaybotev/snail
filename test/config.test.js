'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  USAGE,
  ERR_PERMISSIONS,
  ERR_OWNER,
  configPathMustBeAbsolute,
  parseSnailConfig,
  loadSnailConfig,
  redactSecrets,
} = require('../src/config.js');

const root = path.join(__dirname, '..');

function tmpConfig(body, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-cfg-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, body, { mode });
  return file;
}

const validTwoAccount = `
[[account]]
name = "work"
host = "imap.example.com"
user = "you@example.com"
password = "inline-mail-pass"
mailbox = "INBOX"
mail_dir = "/var/mail/work"
notifier = "webhook"
webhook_url = "https://example.invalid/hook"
webhook_secret = "hook-secret"

[[account]]
name = "personal"
host = "imap.example.com"
user = "you@example.com"
password = "keychain://snail/personal-imap"
mailbox = "INBOX"
mail_dir = "/var/mail/personal"
notifier = "openclaw"
openclaw_token = "keychain://snail/personal-gateway"
`;

test('AC1: two account TOML loads with inline password', () => {
  const r = parseSnailConfig(validTwoAccount);
  assert.equal(r.ok, true);
  assert.equal(r.config.accounts.length, 2);
  assert.equal(r.config.accounts[0].password, 'inline-mail-pass');
  assert.equal(r.config.accounts[1].password, 'keychain://snail/personal-imap');
});

test('AC1: JSON config is rejected', () => {
  const json = fs.readFileSync(path.join(root, 'snail-config.example.json'), 'utf8');
  const r = parseSnailConfig(json);
  assert.equal(r.ok, false);
  assert.match(r.message, /./);
});

test('AC1: relative config path rejected', () => {
  assert.equal(configPathMustBeAbsolute('etc/config.toml'), USAGE);
  assert.equal(configPathMustBeAbsolute('/etc/snail/config.toml'), null);
});

test('AC1: mode 0644 rejected without file body in message', () => {
  const file = tmpConfig(validTwoAccount, 0o644);
  const r = loadSnailConfig(file);
  assert.equal(r.ok, false);
  assert.equal(r.message, ERR_PERMISSIONS);
  assert.doesNotMatch(r.message, /inline-mail-pass/);
});

test('AC1: mismatched owner rejected', () => {
  const file = tmpConfig(validTwoAccount, 0o600);
  const r = loadSnailConfig(file, { uid: process.getuid() + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.message, ERR_OWNER);
});

test('AC2: boolean tls rejected', () => {
  const body = `
[[account]]
name = "a"
host = "h"
user = "u"
password = "p"
mail_dir = "/m"
notifier = "openclaw"
openclaw_token = "t"
tls = true
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.match(r.message, /line 10: boolean/);
});

test('AC2: relative mail_dir rejected', () => {
  const body = `
[[account]]
name = "a"
host = "h"
user = "u"
password = "p"
mail_dir = "relative/path"
notifier = "openclaw"
openclaw_token = "t"
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.match(r.message, /line 7: mail_dir must be an absolute path/);
});

test('AC2: unknown key on account row', () => {
  const body = `
[[account]]
name = "a"
host = "h"
user = "u"
password = "p"
mail_dir = "/m"
notifier = "openclaw"
openclaw_token = "t"
extra = "x"
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.match(r.message, /line 10: unknown key extra/);
});

test('AC2: duplicate name', () => {
  const body = `
[[account]]
name = "dup"
host = "h"
user = "u"
password = "p"
mail_dir = "/m/a"
notifier = "openclaw"
openclaw_token = "t"

[[account]]
name = "dup"
host = "h"
user = "u"
password = "p"
mail_dir = "/m/b"
notifier = "openclaw"
openclaw_token = "t"
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.match(r.message, /duplicate name/);
});

test('AC2: duplicate mail_dir after stripping trailing slash', () => {
  const body = `
[[account]]
name = "a"
host = "h"
user = "u"
password = "p"
mail_dir = "/mail/shared"
notifier = "openclaw"
openclaw_token = "t"

[[account]]
name = "b"
host = "h"
user = "u"
password = "p"
mail_dir = "/mail/shared/"
notifier = "openclaw"
openclaw_token = "t"
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.match(r.message, /duplicate mail_dir/);
});

test('AC10: planted secret absent from schema error message', () => {
  const planted = 'PLANT-SECRET-XYZZY-42';
  const body = `
[[account]]
name = "a"
host = "h"
user = "u"
password = "${planted}"
mail_dir = "/m/a"
notifier = "openclaw"
openclaw_token = "t"

[[account]]
name = "b"
host = "h"
user = "u"
password = "p"
mail_dir = "/m/b"
notifier = "webhook"
webhook_url = "ftp://bad.example/h"
webhook_secret = "s"
`;
  const r = parseSnailConfig(body);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, new RegExp(planted));
});

test('redactSecrets replaces known values', () => {
  const msg = redactSecrets('failed: PLANT-SECRET-XYZZY-42', ['PLANT-SECRET-XYZZY-42']);
  assert.equal(msg, 'failed: [redacted]');
});

test('loadSnailConfig prefixes parse errors', () => {
  const file = tmpConfig('not valid toml {{{');
  const r = loadSnailConfig(file);
  assert.equal(r.ok, false);
  assert.match(r.message, /^config parse error: /);
});

test('example toml parses', () => {
  const text = fs.readFileSync(path.join(root, 'snail.example.toml'), 'utf8');
  const r = parseSnailConfig(text);
  assert.equal(r.ok, true);
  assert.equal(r.config.accounts.length, 2);
});
