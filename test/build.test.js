'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildSh = path.join(root, 'scripts', 'build.sh');

function runBuild(env) {
  return spawnSync('bash', [buildSh], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('node --check snail.js', () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'snail.js')]);
});

test('build.sh without VERSION exits non-zero when no git tag describes HEAD', () => {
  const r = runBuild({ VERSION: '', GIT_DIR: path.join(root, 'dist') });
  assert.notEqual(r.status, 0, r.stderr || r.stdout);
});

test('build.sh with VERSION writes tarball and SHA256SUMS', () => {
  const ver = 'v0.0.0-ci';
  const r = runBuild({ VERSION: ver });
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const tarball = path.join(root, 'dist', `snail-${ver}.tar.gz`);
  const sums = path.join(root, 'dist', 'SHA256SUMS');
  assert.ok(fs.existsSync(tarball));
  assert.ok(fs.existsSync(sums));

  const sumLine = fs.readFileSync(sums, 'utf8').trimEnd();
  assert.match(sumLine, /^[0-9a-f]{64}  snail-v0\.0\.0-ci\.tar\.gz$/);

  const listing = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort();
  const prefix = `snail-${ver}/`;
  for (const name of [
    'package.json',
    'package-lock.json',
    'README.md',
    'LICENSE',
    'snail.js',
    'snail.example.toml',
    'snail.service',
    'scripts/snail-service.sh',
    'launchd/com.snail.agent.plist',
    'build-stamp.json',
    'src/config.js',
  ]) {
    assert.ok(listing.includes(`${prefix}${name}`), `missing ${name}`);
  }

  assert.ok(
    !listing.some((line) => line.includes('run-service.sh')),
    'tarball must not contain run-service.sh',
  );

  assert.ok(
    !listing.some((line) => line.includes('node_modules')),
    'tarball must not contain node_modules',
  );
  assert.ok(
    !listing.some((line) => line.includes('.git')),
    'tarball must not contain .git',
  );

  const stampRaw = execFileSync(
    'tar',
    ['xOf', tarball, `${prefix}build-stamp.json`],
    { encoding: 'utf8' },
  );
  const stamp = JSON.parse(stampRaw);
  assert.equal(stamp.version, ver);
  assert.match(stamp.commitSHA, /^[0-9a-f]{40}$/);
  assert.match(stamp.buildTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
});
