'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('AC1 AC2 AC3: mocked imapflow exists unblocks adapter while idle() stays pending', () => {
  const runner = path.join(__dirname, 'idle-exists-runner.js');
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(
    r.status,
    0,
    r.stderr || r.stdout || `runner exited ${r.status}`,
  );
});
