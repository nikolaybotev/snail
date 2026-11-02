'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

const PINNED_EXEC_START =
  'ExecStart=/ABS/PATH/TO/node /ABS/PATH/TO/HOME/snail/snail.js --config /ABS/PATH/TO/HOME/.config/snail/config.toml';

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

function wrapperScript() {
  return path.join(root, 'scripts', 'snail-service.sh');
}

/** @param {string} nodeBin @param {string} snailBin @param {string[]} extra */
function runWrapper(nodeBin, snailBin, extra = []) {
  return spawnSync('bash', [wrapperScript(), nodeBin, snailBin, ...extra], {
    encoding: 'utf8',
  });
}

/** @param {string} body */
function writeStub(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-wrapper-stub-'));
  const stub = path.join(dir, 'stub.sh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return stub;
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

test('AC1: wrapper maps child exit 2 to 0', () => {
  const stub = writeStub('exit 2');
  const stub2 = runWrapper('/bin/bash', stub);
  assert.equal(stub2.status, 0, stub2.stderr);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-exit2-'));
  const js = path.join(dir, 'exit2.js');
  fs.writeFileSync(js, 'process.exit(2);\n');
  const node2 = runWrapper(process.execPath, js);
  assert.equal(node2.status, 0, node2.stderr);
});

test('AC2: wrapper passes through other child statuses', () => {
  const stub0 = writeStub('exit 0');
  assert.equal(runWrapper('/bin/bash', stub0).status, 0);

  const stub1 = writeStub('exit 1');
  assert.equal(runWrapper('/bin/bash', stub1).status, 1);

  const stubTerm = writeStub('kill -TERM $$');
  assert.equal(runWrapper('/bin/bash', stubTerm).status, 143);
});

test('AC3: systemd ExecStart runs node on snail.js directly', () => {
  const unit = read('snail.service');
  const line = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.equal(line, PINNED_EXEC_START);
  assert.match(unit, /^Type=simple/m);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartPreventExitStatus=2/);
  assert.match(unit, /RestartSec=10/);
});

test('AC4: LaunchAgent uses wrapper with throttle and SuccessfulExit false', () => {
  const plist = read('launchd/com.snail.agent.plist');
  assert.match(plist, /snail-service\.sh/);
  assert.match(
    plist,
    /<key>SuccessfulExit<\/key>\s*\n\s*<false\/>/,
  );
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*\n\s*<integer>10<\/integer>/);
});

test('AC5: wrapper inherits child stdout and stderr', () => {
  const stub = writeStub(
    'echo SNAIL_WRAPPER_STDOUT; echo SNAIL_WRAPPER_STDERR >&2; exit 0',
  );
  const r = runWrapper('/bin/bash', stub);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SNAIL_WRAPPER_STDOUT/);
  assert.match(r.stderr, /SNAIL_WRAPPER_STDERR/);
});

test('AC4: service wrapper name in README and tree', () => {
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

test('AC4: README threat note keeps three-way comparison and Keychain at-rest sentence', () => {
  const readme = read('README.md');
  assert.match(
    readme,
    /Against same-user malware, Keychain, `op:\/\/`, and a mode-`0600` config file are roughly similar\./,
  );
  assert.match(
    readme,
    /The Keychain's value is encryption at rest and keeping the secret out of backups and plain files\./,
  );
  assert.match(
    readme,
    /Snail never logs secrets, never puts them on argv, and never writes them into files it creates\./,
  );
  assert.doesNotMatch(
    readme,
    /Keychain and 1Password help with encryption at rest/,
  );
});

test('AC5: README and example toml document keychain preference and add command', () => {
  const readme = read('README.md');
  const example = read('snail.example.toml');
  assert.match(
    readme,
    /security add-generic-password -s snail -a personal-imap -w/,
  );
  assert.match(example, /password = "REPLACE-WITH-MAILBOX-PASSWORD"/);
  assert.match(example, /password = "keychain:\/\/snail\/personal-imap"/);
  assert.doesNotMatch(readme, /-A\b/);
  assert.doesNotMatch(example, /-A\b/);
  for (const line of readme.split('\n')) {
    assert.doesNotMatch(line, /-w\s+\S/, `README line must not put secret after -w: ${line}`);
  }
  for (const line of example.split('\n')) {
    assert.doesNotMatch(line, /-w\s+\S/, `example line: ${line}`);
  }
  const lines = example.split('\n');
  assert.equal(
    lines[0],
    '# Example only. Copy to ~/.config/snail/config.toml, mode 0600, owned by the service user.',
  );
  assert.equal(lines[1], '# Replace placeholders. Do not commit the real file.');
  assert.equal(
    lines[2],
    '# Inline values are the fallback. Prefer keychain:// on macOS and op:// on Linux.',
  );
});

test('AC6: every plist limits load to GUI Aqua session', () => {
  /** @param {string} dir */
  function listPlists(dir) {
    /** @type {string[]} */
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...listPlists(full));
      } else if (ent.isFile() && ent.name.endsWith('.plist')) {
        out.push(full);
      }
    }
    return out;
  }
  const plists = listPlists(root);
  assert.ok(plists.length >= 1);
  assert.ok(
    plists.some((p) => p.endsWith(path.join('launchd', 'com.snail.agent.plist'))),
  );
  const pattern =
    /<key>LimitLoadToSessionType<\/key>\s*\n\s*<string>Aqua<\/string>/;
  for (const plistPath of plists) {
    const text = fs.readFileSync(plistPath, 'utf8');
    assert.match(text, pattern, plistPath);
  }
});
