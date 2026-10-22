'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createTaskBridge, validateTaskEvent, MAX_BODY_BYTES, MAX_REQUESTS_PER_MINUTE } = require('../src/services/task-bridge.cjs');

const validEvent = { eventId: 'build:run-1', taskId: 'build', status: 'working', title: '构建桌宠', text: '正在校验' };

async function fixture(t, options = {}) {
  const events = [];
  const bridge = createTaskBridge({ onEvent: event => events.push(event), ...options });
  t.after(() => bridge.stop());
  return { bridge, events, state: await bridge.start() };
}

function request(state, { method = 'POST', path = '/events', headers = {}, body = JSON.stringify(validEvent), chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: state.port, path, method, agent: false,
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...headers } }, res => {
      const parts = [];
      res.on('data', data => parts.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Test request timeout')));
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(body);
  });
}

test('default is stopped; concurrent start/stop is idempotent and credentials rotate per start', async t => {
  const bridge = createTaskBridge({ onEvent() {} });
  t.after(() => bridge.stop());
  assert.deepEqual(bridge.snapshot(), { running: false, host: '127.0.0.1', port: null, url: null, token: null });
  const [first, duplicate] = await Promise.all([bridge.start(), bridge.start()]);
  assert.deepEqual(first, duplicate);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isInteger(first.port) && first.port > 0);
  assert.equal(first.url, `http://127.0.0.1:${first.port}/events`);
  first.token = 'changed-copy';
  assert.equal(bridge.snapshot().token, duplicate.token);
  await Promise.all([bridge.stop(), bridge.stop()]);
  assert.equal(bridge.snapshot().token, null);
  await assert.rejects(request(duplicate), /ECONNREFUSED|ECONNRESET/);
  const next = await bridge.start();
  assert.notEqual(next.token, duplicate.token);
  assert.equal((await request(next, { headers: { Authorization: `Bearer ${duplicate.token}` } })).status, 401);
  const [stopped, restarted] = await Promise.all([bridge.stop(), bridge.start()]);
  assert.equal(stopped.running, false);
  assert.equal(restarted.running, true);
});

test('validated task status becomes a fixed task.event command without exposing credentials in HTTP', async t => {
  const { events, state } = await fixture(t);
  const result = await request(state);
  assert.equal(result.status, 202);
  assert.deepEqual(JSON.parse(result.body), { accepted: true });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.stringify(result).includes(state.token), false);
  assert.deepEqual(events, [{ type: 'task.event', ...validEvent }]);
  assert.equal(Object.isFrozen(events[0]), true);
  for (const status of ['waiting', 'completed', 'failed', 'cancelled']) {
    assert.equal((await request(state, { body: JSON.stringify({ eventId: `step-${status}`, taskId: 'build', status }) })).status, 202);
  }
});

test('authentication rejects missing, wrong length, wrong token, duplicate and different schemes', async t => {
  const { events, state } = await fixture(t);
  for (const value of ['', `Basic ${state.token}`, 'Bearer x', `Bearer ${'A'.repeat(43)}`, `Bearer ${state.token}x`,
    [`Bearer ${state.token}`, `Bearer ${'A'.repeat(43)}`]]) {
    const result = await request(state, { headers: { Authorization: value } });
    assert.equal(result.status, 401);
    assert.equal(result.body.includes(state.token), false);
  }
  assert.equal(events.length, 0);
});

test('browser Origin, fetch metadata, rebinding Host and alternate methods/paths are rejected', async t => {
  const { events, state } = await fixture(t);
  for (const headers of [{ Origin: 'https://starwright.xyz' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Mode': 'no-cors' },
    { Host: `localhost:${state.port}` }, { Host: `attacker.example:${state.port}` }]) {
    assert.equal((await request(state, { headers })).status, 403);
  }
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request(state, { method })).status, 405);
  for (const path of ['/', '/events?token=value', '/events/', '/%65vents', 'http://127.0.0.1/events'])
    assert.equal((await request(state, { path })).status, 404);
  assert.equal(events.length, 0);
});

test('only bounded UTF-8 JSON is accepted, including chunked uploads', async t => {
  const { events, state } = await fixture(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'application/json; charset=gbk' }, { 'Content-Encoding': 'gzip' }])
    assert.equal((await request(state, { headers })).status, 415);
  assert.equal((await request(state, { headers: { 'Content-Length': MAX_BODY_BYTES + 1 }, body: '' })).status, 413);
  assert.equal((await request(state, { chunks: [' '.repeat(MAX_BODY_BYTES), 'x'] })).status, 413);
  assert.equal((await request(state, { body: Buffer.from([0xff, 0xfe]) })).status, 400);
  for (const body of ['', '{', 'null', '[]', '"text"']) assert.equal((await request(state, { body })).status, 400);
  assert.equal(events.length, 0);
  const source = Buffer.from(JSON.stringify(validEvent));
  assert.equal((await request(state, { headers: { 'Content-Type': 'application/json; charset=utf-8' },
    chunks: [source.subarray(0, source.length - 5), source.subarray(source.length - 5)] })).status, 202);
  assert.equal(events.length, 1);
});

test('schema permits only bounded identifiers/status/display text, never commands or arbitrary structures', async t => {
  const { events, state } = await fixture(t);
  const invalid = [
    { ...validEvent, command: 'echo secret' }, { ...validEvent, path: 'C:\\private.txt' },
    { ...validEvent, url: 'https://attacker.example' }, { ...validEvent, type: 'todo.add' },
    { ...validEvent, status: 'execute' }, { ...validEvent, eventId: '../file' }, { ...validEvent, taskId: '' },
    { ...validEvent, eventId: 'x'.repeat(121) }, { ...validEvent, title: 'x'.repeat(201) },
    { ...validEvent, text: 'x'.repeat(501) }, { ...validEvent, text: '\u0000' },
    { ...validEvent, title: {} }, { ...validEvent, text: ['nested'] },
    { taskId: 'task', status: 'working' }, { eventId: 'e', taskId: 'task' },
    JSON.parse('{"eventId":"e","taskId":"t","status":"working","__proto__":{"polluted":true}}'),
  ];
  for (const payload of invalid) assert.equal((await request(state, { body: JSON.stringify(payload) })).status, 400);
  assert.equal(events.length, 0);
  assert.equal({}.polluted, undefined);
  assert.throws(() => validateTaskEvent(Object.defineProperty({ ...validEvent }, 'title', { get() { throw new Error('getter ran'); } })), /Invalid event/);
});

test('rate limit includes unauthorized requests and resets after one minute', async t => {
  let time = 1000;
  const { events, state } = await fixture(t, { now: () => time });
  for (let index = 0; index < MAX_REQUESTS_PER_MINUTE; index++)
    assert.equal((await request(state, { headers: { Authorization: '' } })).status, 401);
  const limited = await request(state);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(events.length, 0);
  time += 60_000;
  assert.equal((await request(state)).status, 202);
  assert.equal(events.length, 1);
});

test('handler failure is generic and never returns sensitive exception text', async t => {
  const { state } = await fixture(t, { onEvent: async () => { throw new Error('private-token-or-path'); } });
  const result = await request(state);
  assert.equal(result.status, 500);
  assert.deepEqual(JSON.parse(result.body), { error: 'DISPATCH' });
  assert.equal(result.body.includes('private-token-or-path'), false);
});

test('stop closes a pending upload before it can dispatch; no listener remains', async t => {
  const { bridge, events, state } = await fixture(t);
  const socket = net.connect({ host: '127.0.0.1', port: state.port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  // An explicit bridge stop may reset the incomplete request; only close is relevant here.
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`POST /events HTTP/1.1\r\nHost: 127.0.0.1:${state.port}\r\nAuthorization: Bearer ${state.token}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`);
  await new Promise(resolve => setImmediate(resolve));
  await bridge.stop();
  await closed;
  assert.equal(events.length, 0);
  assert.equal(bridge.snapshot().running, false);
});

test('Expect requests and protocol upgrades cannot dispatch', async t => {
  const { events, state } = await fixture(t);
  assert.equal((await request(state, { headers: { Expect: '100-continue' } })).status, 417);
  assert.equal((await request(state, { headers: { Expect: 'something' } })).status, 417);
  await assert.rejects(request(state, { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } }), /ECONNRESET|socket hang up/);
  assert.equal(events.length, 0);
});
