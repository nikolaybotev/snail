'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseKeychainReference,
  parseOpReference,
  isInlineSecret,
  keychainExecArgs,
  defaultKeychainRunner,
  readOpServiceAccountToken,
  redactKnownSecrets,
  createAccountSecretResolver,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} = require('../src/secrets.js');

test('AC1: keychainExecArgs returns security binary and find-generic-password argv', () => {
  const { file, args } = keychainExecArgs('my-service', 'my-account');
  assert.equal(file, '/usr/bin/security');
  assert.deepEqual(args, [
    'find-generic-password',
    '-s',
    'my-service',
    '-a',
    'my-account',
    '-w',
  ]);
});

test('AC2: defaultKeychainRunner calls exec with options and trims stdout', async () => {
  const secret = 'secret-value';
  let callCount = 0;
  /** @type {[string, string[], object] | null} */
  let lastCall = null;
  const execImpl = async (file, args, options) => {
    callCount += 1;
    lastCall = [file, args, options];
    return { stdout: `${secret}\n` };
  };
  const result = await defaultKeychainRunner('my-service', 'my-account', execImpl);
  assert.equal(result, secret);
  assert.equal(callCount, 1);
  assert.ok(lastCall);
  assert.equal(lastCall[0], '/usr/bin/security');
  assert.deepEqual(lastCall[1], [
    'find-generic-password',
    '-s',
    'my-service',
    '-a',
    'my-account',
    '-w',
  ]);
  assert.deepEqual(lastCall[2], { encoding: 'utf8', maxBuffer: 1048576 });
  assert.equal('shell' in lastCall[2], false);
  for (const part of lastCall[1]) {
    assert.doesNotMatch(part, new RegExp(secret));
  }
});

test('AC3: secrets.js uses execFileAsync default and no native keychain modules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'secrets.js'), 'utf8');
  assert.match(src, /const \{ execFile \} = require\('node:child_process'\)/);
  assert.match(src, /const execFileAsync = promisify\(execFile\)/);
  assert.match(
    src,
    /defaultKeychainRunner\(service, account, execImpl = execFileAsync\)/,
  );
  assert.doesNotMatch(src, /\bexec\s*\(/);
  assert.doesNotMatch(src, /\bshell\s*:/);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );
  assert.equal('keytar' in (pkg.dependencies ?? {}), false);
  assert.equal('keytar' in (pkg.devDependencies ?? {}), false);
  assert.equal('@napi-rs/keyring' in (pkg.dependencies ?? {}), false);
  assert.equal('@napi-rs/keyring' in (pkg.devDependencies ?? {}), false);
});

test('AC10: inline value is not a reference', () => {
  assert.equal(isInlineSecret('plain-password'), true);
  assert.equal(parseKeychainReference('plain-password'), null);
  assert.equal(parseOpReference('plain-password'), null);
});

test('AC10: keychain reference parses', () => {
  const p = parseKeychainReference('keychain://snail/personal-imap');
  assert.deepEqual(p, { service: 'snail', account: 'personal-imap' });
  assert.equal(parseKeychainReference('keychain://only-service'), null);
  assert.equal(parseKeychainReference('keychain://a/b/extra'), null);
});

test('AC10: op reference parses', () => {
  const p = parseOpReference('op://vault-id/item-id/field');
  assert.deepEqual(p, { vault: 'vault-id', item: 'item-id', field: 'field' });
  assert.equal(parseOpReference('op://incomplete'), null);
});

test('AC10: inline resolve does not call runners', async () => {
  let keychainCalls = 0;
  let opCalls = 0;
  const resolver = createAccountSecretResolver({
    keychainRunner: async () => {
      keychainCalls += 1;
      return 'x';
    },
    opRunner: async () => {
      opCalls += 1;
      return 'x';
    },
  });
  const v = await resolver.resolve('inline-mail-pass');
  assert.equal(v, 'inline-mail-pass');
  assert.equal(keychainCalls, 0);
  assert.equal(opCalls, 0);
});

test('cache: second resolve does not call runner again', async () => {
  let calls = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    keychainRunner: async () => {
      calls += 1;
      return 'resolved-secret';
    },
  });
  const ref = 'keychain://svc/acct';
  assert.equal(await resolver.resolve(ref), 'resolved-secret');
  assert.equal(await resolver.resolve(ref), 'resolved-secret');
  assert.equal(calls, 1);
});

test('clearCache after reload resolves again', async () => {
  let calls = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    keychainRunner: async () => {
      calls += 1;
      return `secret-${calls}`;
    },
  });
  const ref = 'keychain://svc/acct';
  assert.equal(await resolver.resolve(ref), 'secret-1');
  resolver.clearCache();
  assert.equal(await resolver.resolve(ref), 'secret-2');
  assert.equal(calls, 2);
});

test('AC10: keychain argv never includes resolved secret', () => {
  const planted = 'PLANT-SECRET-XYZZY-99';
  const { args } = keychainExecArgs('my-service', 'my-account');
  assert.deepEqual(args, ['find-generic-password', '-s', 'my-service', '-a', 'my-account', '-w']);
  for (const part of args) {
    assert.doesNotMatch(part, new RegExp(planted));
  }
  assert.doesNotMatch(JSON.stringify(args), new RegExp(planted));
});

test('AC10: op runner receives token only via injected runner, not argv', async () => {
  const token = 'op-token-bytes-should-not-log';
  const planted = 'PLANT-SECRET-XYZZY-99';
  /** @type {string[][]} */
  const argvSnapshots = [];
  const resolver = createAccountSecretResolver({
    readOpToken: () => token,
    opRunner: async (ref, tok) => {
      argvSnapshots.push(['op', 'read', ref]);
      assert.equal(tok, token);
      assert.doesNotMatch(ref, new RegExp(planted));
      return 'hook-value';
    },
  });
  const v = await resolver.resolve('op://v/i/f');
  assert.equal(v, 'hook-value');
  assert.equal(argvSnapshots.length, 1);
  assert.deepEqual(argvSnapshots[0], ['op', 'read', 'op://v/i/f']);
  assert.doesNotMatch(JSON.stringify(argvSnapshots), new RegExp(token));
});

test('readOpServiceAccountToken from SNAIL_OP_TOKEN_FILE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-op-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, 'tok123\n', { mode: 0o600 });
  assert.equal(readOpServiceAccountToken({ SNAIL_OP_TOKEN_FILE: file }), 'tok123');
});

test('readOpServiceAccountToken from CREDENTIALS_DIRECTORY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-cred-'));
  fs.writeFileSync(path.join(dir, 'op-token'), 'from-cred\n', { mode: 0o600 });
  assert.equal(readOpServiceAccountToken({ CREDENTIALS_DIRECTORY: dir }), 'from-cred');
});

test('Linux keychain reference fails on that resolver only', async () => {
  const delays = [];
  const resolverA = createAccountSecretResolver({
    platform: 'linux',
    sleeper: async (ms) => {
      delays.push(ms);
      throw new Error('stop-a');
    },
    keychainRunner: async () => 'never',
  });
  const resolverB = createAccountSecretResolver({
    keychainRunner: async () => {
      throw new Error('should not run for inline');
    },
  });

  await assert.rejects(
    () => resolverA.resolve('keychain://snail/personal-imap'),
    /stop-a/,
  );
  assert.deepEqual(delays, [INITIAL_BACKOFF_MS]);

  const inline = await resolverB.resolve('other-inline-pass');
  assert.equal(inline, 'other-inline-pass');
});

test('AC10: planted secret absent from resolver log lines', async () => {
  const planted = 'PLANT-SECRET-XYZZY-42';
  const lines = [];
  let attempts = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    secretLiteralsForRedaction: [planted],
    log: (line) => lines.push(line),
    sleeper: async () => {
      attempts += 1;
      if (attempts >= 2) throw new Error('stop');
    },
    keychainRunner: async () => {
      throw new Error(`runner failed with ${planted}`);
    },
  });
  await assert.rejects(() => resolver.resolve('keychain://s/a'), /stop/);
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.doesNotMatch(line, new RegExp(planted));
    assert.match(line, /\[redacted\]/);
  }
});

test('runner stderr is not forwarded to log callback', async () => {
  const lines = [];
  let attempts = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    log: (line) => lines.push(line),
    sleeper: async () => {
      attempts += 1;
      if (attempts >= 1) throw new Error('stop');
    },
    keychainRunner: async () => {
      const err = new Error('exit 1');
      err.stderr = 'sensitive-stderr-from-security';
      throw err;
    },
  });
  await assert.rejects(() => resolver.resolve('keychain://s/a'), /stop/);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /sensitive-stderr-from-security/);
});

test('redactKnownSecrets replaces secret with [redacted]', () => {
  const s = 'PLANT-SECRET-XYZZY-42';
  assert.equal(redactKnownSecrets(`error: ${s}`, [s]), 'error: [redacted]');
});

test('AC16: secret resolve failure uses FR6 backoff sequence', async () => {
  const delays = [];
  let failures = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    sleeper: async (ms) => {
      delays.push(ms);
    },
    keychainRunner: async () => {
      failures += 1;
      if (failures < 6) {
        throw new Error('fail');
      }
      return 'ok';
    },
  });
  const v = await resolver.resolve('keychain://svc/acct');
  assert.equal(v, 'ok');
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000]);
});

test('AC16: successful resolve resets backoff to 5s', async () => {
  const delays = [];
  let pass = 0;
  const resolver = createAccountSecretResolver({
    platform: 'darwin',
    sleeper: async (ms) => {
      delays.push(ms);
    },
    keychainRunner: async () => {
      pass += 1;
      if (pass === 1) throw new Error('once');
      if (pass === 2) return 'first-field';
      if (pass === 3) throw new Error('twice');
      return 'second-field';
    },
  });
  assert.equal(await resolver.resolve('keychain://a/one'), 'first-field');
  assert.equal(await resolver.resolve('keychain://b/two'), 'second-field');
  assert.deepEqual(delays, [INITIAL_BACKOFF_MS, INITIAL_BACKOFF_MS]);
});

test('failed op resolve without token backs off per account', async () => {
  const delays = [];
  let attempts = 0;
  const resolver = createAccountSecretResolver({
    readOpToken: () => null,
    sleeper: async (ms) => {
      delays.push(ms);
      attempts += 1;
      if (attempts >= 2) throw new Error('stop-op');
    },
    opRunner: async () => 'never',
  });
  await assert.rejects(() => resolver.resolve('op://v/i/f'), /stop-op/);
  assert.deepEqual(delays, [INITIAL_BACKOFF_MS, INITIAL_BACKOFF_MS * 2]);
  assert.equal(MAX_BACKOFF_MS, 60000);
});

test('two resolvers backoff independently', async () => {
  const delaysA = [];
  const delaysB = [];
  let failA = 0;

  const resolverA = createAccountSecretResolver({
    platform: 'darwin',
    sleeper: async (ms) => {
      delaysA.push(ms);
    },
    keychainRunner: async () => {
      failA += 1;
      if (failA < 2) throw new Error('a');
      return 'done-a';
    },
  });

  const resolverB = createAccountSecretResolver({
    platform: 'darwin',
    keychainRunner: async () => 'done-b',
  });

  const [a, b] = await Promise.all([
    resolverA.resolve('keychain://sa/a'),
    resolverB.resolve('keychain://sb/b'),
  ]);
  assert.equal(a, 'done-a');
  assert.equal(b, 'done-b');
  assert.deepEqual(delaysA, [INITIAL_BACKOFF_MS]);
  assert.deepEqual(delaysB, []);
});
