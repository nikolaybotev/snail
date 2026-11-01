'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'release-version.sh');

/**
 * @param {string} repoDir
 * @param {Record<string, string | undefined>} [extraEnv]
 */
function runScript(repoDir, extraEnv = {}) {
  return spawnSync('bash', [script], {
    cwd: repoDir,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
}

/**
 * @param {string} dir
 */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'marker'), '1\n');
  execFileSync('git', ['add', 'marker'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

/**
 * @param {string} dir
 * @param {string} subject
 */
function mergeCommit(dir, subject) {
  fs.appendFileSync(path.join(dir, 'marker'), 'x\n');
  execFileSync('git', ['add', 'marker'], { cwd: dir });
  execFileSync('git', ['commit', '-m', subject], { cwd: dir });
}

test('first semver tag is v0.1.0 when none exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    mergeCommit(dir, 'feat: portable mail (#1)');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABELS: '' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'tag v0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('patch bump by default from latest semver tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    execFileSync('git', ['tag', 'v0.1.0'], { cwd: dir });
    mergeCommit(dir, 'fix: something (#2)');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABELS: '' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'tag v0.1.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release:minor bumps minor and resets patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    execFileSync('git', ['tag', 'v0.1.5'], { cwd: dir });
    mergeCommit(dir, 'feat: bigger (#3)');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABELS: 'release:minor' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'tag v0.2.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release:major bumps major and resets minor and patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    execFileSync('git', ['tag', 'v0.9.2'], { cwd: dir });
    mergeCommit(dir, 'feat!: break (#4)');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABELS: 'release:major' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'tag v1.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both release labels exit non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    execFileSync('git', ['tag', 'v0.1.0'], { cwd: dir });
    mergeCommit(dir, 'feat: labels (#5)');
    const r = runScript(dir, {
      RELEASE_VERSION_TEST_LABELS: 'release:minor\nrelease:major',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /both release:minor and release:major/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noop when HEAD already has a semver tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    execFileSync('git', ['tag', 'v0.2.0'], { cwd: dir });
    const r = runScript(dir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'noop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('subject without (#N) exits non-zero and prints no tag line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    mergeCommit(dir, 'feat: no pull request reference');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABELS: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no pull request number/);
    assert.doesNotMatch(r.stdout, /^tag v/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('injectable label lookup failure exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snail-rel-'));
  try {
    initRepo(dir);
    mergeCommit(dir, 'feat: lookup (#6)');
    const r = runScript(dir, { RELEASE_VERSION_TEST_LABEL_LOOKUP_FAIL: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /label lookup failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
