'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTomlSubset, configPermissionsAcceptable } = require('../src/toml-subset.js');

test('parses strings, integers, and arrays of strings', () => {
  const r = parseTomlSubset('name = "a"\ncount = 42\nitems = ["x", "y"]\n');
  assert.equal(r.ok, true);
  assert.equal(r.table.name.content.value, 'a');
  assert.equal(r.table.count.content.value, 42);
  assert.deepEqual(r.table.items.content.value, ['x', 'y']);
});

test('parses table array headers', () => {
  const r = parseTomlSubset('[[account]]\nname = "a"\n[[account]]\nname = "b"\n');
  assert.equal(r.ok, true);
  assert.equal(r.table.account.content.value.length, 2);
  assert.equal(r.table.account.content.value[0].name.content.value, 'a');
});

test('subset rejects boolean', () => {
  const r = parseTomlSubset('flag = true\n');
  assert.equal(r.ok, false);
  assert.match(r.message, /^line 1: boolean$/);
});

test('subset rejects dotted key in assignment', () => {
  const r = parseTomlSubset('a.b = "x"\n');
  assert.equal(r.ok, false);
  assert.match(r.message, /^line 1: dotted key$/);
});

test('subset rejects inline table', () => {
  const r = parseTomlSubset('t = { x = 1 }\n');
  assert.equal(r.ok, false);
  assert.match(r.message, /^line 1: inline table$/);
});

test('subset rejects dotted table header', () => {
  const r = parseTomlSubset('[a.b]\n');
  assert.equal(r.ok, false);
  assert.match(r.message, /^line 1: dotted key$/);
});

test('configPermissionsAcceptable rejects group/world bits', () => {
  assert.equal(configPermissionsAcceptable(0o600), true);
  assert.equal(configPermissionsAcceptable(0o644), false);
  assert.equal(configPermissionsAcceptable(0o660), false);
});
