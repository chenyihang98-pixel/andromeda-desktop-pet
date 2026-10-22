'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertPayloadBudget} = require('../src/ipc-budget.cjs');

test('8 MiB typed recording stays within IPC budget without JSON expansion', () => {
  const payload = {method: 'transcribe', payload: {audio: new Uint8Array(8 * 1024 * 1024), mimeType: 'audio/webm'}};
  const original = JSON.stringify;JSON.stringify = () => {throw new Error('must not serialize binary');};
  try {assert.ok(assertPayloadBudget(payload) < 8 * 1024 * 1024 + 256);} finally {JSON.stringify = original;}
  assert.throws(() => assertPayloadBudget({audio: new Uint8Array(12_000_001)}), /过大/);
});

test('IPC budget rejects cycles, accessors, excessive nesting and UTF-8 text without invoking getters', () => {
  let invoked = false;const getter = {};Object.defineProperty(getter, 'secret', {enumerable: true, get() {invoked = true;return 'secret';}});
  assert.throws(() => assertPayloadBudget(getter));assert.equal(invoked, false);
  const cycle = {};cycle.self = cycle;assert.throws(() => assertPayloadBudget(cycle));
  let nested = {};for (let i = 0; i < 40; i++) nested = {nested};assert.throws(() => assertPayloadBudget(nested));
  assert.throws(() => assertPayloadBudget('界'.repeat(1000), 2000));
  assert.ok(assertPayloadBudget({backup: {schema: 'test', list: [1, null, 'ok']}}) > 0);
});
