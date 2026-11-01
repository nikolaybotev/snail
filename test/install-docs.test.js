'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** @param {string} text */
function assertNoForbiddenInstallSecrets(text, label) {
  assert.doesNotMatch(text, /\bsudo\b/, `${label} must not mention sudo`);
  assert.doesNotMatch(
    text,
    /OP_SERVICE_ACCOUNT_TOKEN\s*=/,
    `${label} must not set a service-account token`,
  );
  assert.doesNotMatch(
    text,
    /ops_[A-Za-z0-9]{20,}/,
    `${label} must not contain a token literal`,
  );
  for (const bad of [
    'REPLACE-WITH-MAILBOX-PASSWORD',
    'REPLACE-WITH-WEBHOOK-TOKEN',
    'supersecret',
    'hunter2',
  ]) {
    assert.doesNotMatch(text, new RegExp(bad), `${label} must not contain ${bad}`);
  }
}

test('AC13: systemd user unit uses --config and restart policy', () => {
  const unit = read('snail.service');
  assert.match(unit, /--config/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartPreventExitStatus=2/);
  assert.match(
    unit,
    /\/ABS\/PATH\/TO\/HOME\/\.config\/snail\/config\.toml/,
  );
  assert.doesNotMatch(unit, /^User=/m, 'user unit must not set User=');
  assert.doesNotMatch(unit, /^WantedBy=multi-user\.target/m);
  assert.match(unit, /WantedBy=default\.target/);
  assertNoForbiddenInstallSecrets(unit, 'snail.service');
});

test('AC13: LaunchAgent runs in GUI session with exit-2 wrapper', () => {
  const plist = read('launchd/com.snail.agent.plist');
  assert.match(plist, /--config/);
  assert.match(plist, /<string>com\.snail\.agent<\/string>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*\n\s*<string>Aqua<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
  assert.match(
    plist,
    /<key>SuccessfulExit<\/key>\s*\n\s*<false\/>/,
  );
  assert.match(plist, /snail-service\.sh/);
  assert.match(
    plist,
    /\/ABS\/PATH\/TO\/HOME\/\.config\/snail\/config\.toml/,
  );
  assertNoForbiddenInstallSecrets(plist, 'com.snail.agent.plist');
});

test('AC13: snail-service.sh maps exit 2 to 0', () => {
  const sh = read('scripts/snail-service.sh');
  assert.match(sh, /-eq 2/);
  assert.match(sh, /exit 0/);
  assertNoForbiddenInstallSecrets(sh, 'snail-service.sh');
});

test('AC4: service wrapper name in unit, README, and tree', () => {
  const unit = read('snail.service');
  assert.match(unit, /snail-service\.sh/);
  assert.doesNotMatch(unit, /run-service\.sh/);
  const readme = read('README.md');
  assert.match(readme, /snail-service\.sh/);
  assert.doesNotMatch(readme, /run-service\.sh/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'snail-service.sh')));
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'run-service.sh')));
});

test('AC13: README install paths use placeholders only', () => {
  const readme = read('README.md');
  assert.match(readme, /snail\.example\.toml/);
  assert.match(readme, /live reload/i);
  assert.match(readme, /keychain:\/\//);
  assert.match(readme, /op:\/\//);
  assert.doesNotMatch(readme, /\bsudo\b/);
});
