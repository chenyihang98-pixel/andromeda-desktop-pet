'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createFullscreenMonitor, HEARTBEAT_TIMEOUT_MS, MAX_LINE_BYTES, MAX_CHUNK_BYTES } = require('../src/fullscreen-monitor.cjs');

const helperPath = path.resolve('native', 'fullscreen-helper.exe');
const monitorBounds = { x: -3840, y: -200, width: 3840, height: 2160 };
const heartbeat = (bounds = monitorBounds) => JSON.stringify(bounds
  ? { version: 1, fullscreen: true, monitor: bounds }
  : { version: 1, fullscreen: false }) + '\n';

function fixture({ spawnError = false, onChange: extraChange } = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), spawned = [], changes = [], errors = [];
  const schedule = (fn, ms) => { const id = ++serial; timers.set(id, { fn, due: now + ms }); return id; };
  const cancel = id => timers.delete(id);
  const clock = {
    pending: () => timers.size,
    advance(ms) {
      const until = now + ms;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > until) break;
        now = timer.due; timers.delete(id); timer.fn();
      }
      now = until;
    },
  };
  function spawn(command, args, options) {
    if (spawnError) throw new Error('private machine path and sensitive output');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.kills = 0; child.stdin.ends = 0; child.stdout.destroys = 0;
    child.kill = () => { child.kills++; };
    child.stdin.end = () => { child.stdin.ends++; };
    child.stdout.destroy = () => { child.stdout.destroys++; };
    spawned.push({ command, args, options, child });
    return child;
  }
  const monitor = createFullscreenMonitor({
    helperPath, parentPid: 1234, spawn,
    onChange: value => { changes.push(value); extraChange?.(value); },
    onError: reason => errors.push(reason), setTimeout: schedule, clearTimeout: cancel,
  });
  return { monitor, spawned, changes, errors, clock, timers, child: () => spawned.at(-1).child };
}

test('launches only the fixed helper with separate parent PID argument and hidden shell-free pipes', () => {
  const f = fixture();
  assert.equal(f.monitor.start(), true);
  assert.equal(f.monitor.start(), true);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].command, helperPath);
  assert.deepEqual(f.spawned[0].args, ['--parent-pid', '1234']);
  assert.deepEqual(f.spawned[0].options, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(f.clock.pending(), 1);
  f.monitor.stop();
});

test('delivers partial lines, CRLF, multiple lines and duplicate valid heartbeats', () => {
  const f = fixture(); f.monitor.start();
  const line = heartbeat();
  f.child().stdout.emit('data', Buffer.from(line.slice(0, 15)));
  assert.deepEqual(f.changes, []);
  f.child().stdout.emit('data', Buffer.from(line.slice(15) + line.replace('\n', '\r\n') + heartbeat(null)));
  assert.deepEqual(f.changes, [monitorBounds, monitorBounds, null]);
  assert.equal(f.clock.pending(), 1);
  assert.deepEqual(f.errors, []);
  f.monitor.stop();
});

test('fresh heartbeats renew the watchdog but partial data cannot keep it alive', () => {
  const f = fixture(); f.monitor.start();
  f.clock.advance(HEARTBEAT_TIMEOUT_MS - 1);
  f.child().stdout.emit('data', heartbeat());
  f.clock.advance(HEARTBEAT_TIMEOUT_MS - 1);
  f.child().stdout.emit('data', '{"version":');
  assert.deepEqual(f.errors, []);
  f.clock.advance(1);
  assert.deepEqual(f.errors, ['heartbeat-timeout']);
  assert.deepEqual(f.changes, [monitorBounds, null]);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.child().kills, 1);
  f.clock.advance(30_000);
  assert.equal(f.spawned.length, 1, 'failure must not trigger a respawn loop');
});

test('missing first heartbeat fails open after three seconds', () => {
  const f = fixture(); f.monitor.start(); f.clock.advance(HEARTBEAT_TIMEOUT_MS);
  assert.deepEqual(f.changes, [null]);
  assert.deepEqual(f.errors, ['heartbeat-timeout']);
});

test('rejects malformed packets and invalid monitor bounds with a safe fixed error', () => {
  const invalid = [
    '\n', 'sensitive untrusted output\n', 'null\n', '[]\n', '{}\n',
    '{"version":2,"fullscreen":false}\n', '{"version":1,"fullscreen":0}\n',
    '{"version":1,"fullscreen":false,"monitor":null}\n',
    '{"version":1,"fullscreen":true}\n',
    '{"version":1,"fullscreen":true,"monitor":[]}\n',
    heartbeat({ ...monitorBounds, x: -2_147_483_649 }),
    heartbeat({ ...monitorBounds, x: 2_147_483_647 }),
    heartbeat({ ...monitorBounds, y: 2_147_483_647 }),
    heartbeat({ ...monitorBounds, x: 0.5 }), heartbeat({ ...monitorBounds, x: '0' }),
    heartbeat({ ...monitorBounds, width: 0 }), heartbeat({ ...monitorBounds, height: -1 }),
    heartbeat({ ...monitorBounds, width: Number.MAX_SAFE_INTEGER }),
    heartbeat({ ...monitorBounds, height: null }), heartbeat({ ...monitorBounds, unexpected: 1 }),
  ];
  for (const line of invalid) {
    const f = fixture(); f.monitor.start(); f.child().stdout.emit('data', line);
    assert.deepEqual(f.changes, [null], line);
    assert.deepEqual(f.errors, ['invalid-data'], line);
    assert.equal(f.clock.pending(), 0);
    assert.equal(f.child().kills, 1);
  }
});

test('bounds buffered output, long complete lines and oversized chunks', () => {
  for (const chunks of [
    [' '.repeat(MAX_LINE_BYTES), ' '],
    [' '.repeat(MAX_LINE_BYTES + 1) + '\n'],
    [Buffer.alloc(MAX_CHUNK_BYTES + 1)],
    [{ untrusted: 'not a stream chunk' }],
  ]) {
    const f = fixture(); f.monitor.start();
    for (const chunk of chunks) f.child().stdout.emit('data', chunk);
    assert.deepEqual(f.changes, [null]);
    assert.deepEqual(f.errors, ['invalid-data']);
    assert.equal(f.clock.pending(), 0);
  }
});

test('an exactly bounded JSON line is accepted and validated independently of other lines', () => {
  const f = fixture(); f.monitor.start();
  const line = heartbeat(null).trimEnd();
  f.child().stdout.emit('data', line + ' '.repeat(MAX_LINE_BYTES - Buffer.byteLength(line)) + '\n' + heartbeat());
  assert.deepEqual(f.changes, [null, monitorBounds]);
  assert.deepEqual(f.errors, []);
  f.monitor.stop();
});

test('spawn exceptions fail open without exposing the exception or retrying', () => {
  const f = fixture({ spawnError: true });
  assert.equal(f.monitor.start(), false);
  assert.deepEqual(f.changes, [null]);
  assert.deepEqual(f.errors, ['spawn-failed']);
  assert.equal(f.clock.pending(), 0);
  f.monitor.stop();
  assert.deepEqual(f.errors, ['spawn-failed']);
});

test('exit, spawn errors and broken pipes each fail open only once', () => {
  for (const [target, event, expected] of [
    ['child', 'exit', 'helper-exited'], ['child', 'close', 'helper-exited'],
    ['child', 'error', 'spawn-failed'], ['stdout', 'error', 'helper-output-error'],
    ['stdin', 'error', 'helper-output-error'], ['stdout', 'end', 'helper-exited'],
  ]) {
    const f = fixture(); f.monitor.start(); const child = f.child();
    child.stdout.emit('data', heartbeat());
    (target === 'child' ? child : child[target]).emit(event, new Error('private output'));
    child.emit('exit', 1); child.emit('close', 1); child.emit('error', new Error('delayed error'));
    child.stdout.emit('error', new Error('delayed pipe error'));
    child.stdin.emit('error', new Error('delayed pipe error'));
    assert.deepEqual(f.changes, [monitorBounds, null]);
    assert.deepEqual(f.errors, [expected]);
    assert.equal(f.clock.pending(), 0);
    assert.equal(child.stdin.ends, 1);
    assert.equal(child.stdout.destroys, 1);
    assert.equal(child.kills, 1);
  }
});

test('intentional stop is quiet, clears resources, and ignores late child callbacks', () => {
  const f = fixture(); f.monitor.start(); const child = f.child();
  child.stdout.emit('data', heartbeat());
  const data = child.stdout.listeners('data')[0];
  const watchdog = [...f.timers.values()][0].fn;
  f.monitor.stop(); f.monitor.stop();
  data(heartbeat()); watchdog();
  child.stdout.emit('data', heartbeat()); child.emit('exit', 1);
  child.emit('error', new Error('late')); child.stdout.emit('error', new Error('late'));
  f.clock.advance(10_000);
  assert.deepEqual(f.changes, [monitorBounds, null]);
  assert.deepEqual(f.errors, []);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(f.clock.pending(), 0);
  assert.equal(child.kills, 1);
});

test('explicit restart isolates the new child from stale data, errors and watchdog callbacks', () => {
  const f = fixture(); f.monitor.start(); const first = f.child();
  const oldData = first.stdout.listeners('data')[0];
  const oldError = first.listeners('error')[0];
  const oldWatchdog = [...f.timers.values()][0].fn;
  first.stdout.emit('data', heartbeat());
  f.monitor.stop(); f.monitor.start(); const second = f.child();
  oldData(heartbeat()); oldError(new Error('late')); oldWatchdog();
  first.emit('exit', 1); first.stdout.emit('data', heartbeat());
  assert.deepEqual(f.changes, [monitorBounds, null]);
  second.stdout.emit('data', heartbeat(null));
  assert.deepEqual(f.changes, [monitorBounds, null, null]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.clock.pending(), 1);
  f.monitor.stop();
});

test('failure can be explicitly restarted without retaining buffered data or callbacks', () => {
  const f = fixture(); f.monitor.start(); const first = f.child();
  const oldData = first.stdout.listeners('data')[0];
  first.stdout.emit('data', '{"version":');
  first.emit('exit', 1);
  assert.equal(f.monitor.start(), true);
  const second = f.child();
  assert.notEqual(first, second);
  oldData('1,"fullscreen":false}\n');
  second.stdout.emit('data', heartbeat());
  assert.deepEqual(f.changes, [null, monitorBounds]);
  assert.deepEqual(f.errors, ['helper-exited']);
  assert.equal(f.clock.pending(), 1);
  f.monitor.stop();
});

test('a stopped monitor cannot process a later line in the same chunk', () => {
  let f;
  f = fixture({ onChange: value => { if (value) f.monitor.stop(); } });
  f.monitor.start(); f.child().stdout.emit('data', heartbeat() + heartbeat());
  assert.deepEqual(f.changes, [monitorBounds, null]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.clock.pending(), 0);
});

test('rejects unsafe helper configuration before attempting a process launch', () => {
  const callbacks = { onChange() {}, onError() {} };
  for (const value of ['', 'relative.exe', 'helper\0.exe', null]) {
    assert.throws(() => createFullscreenMonitor({ ...callbacks, helperPath: value }), TypeError);
  }
  for (const parentPid of [-1, 0, 0.1, '1', NaN, Infinity, 4_294_967_296]) {
    assert.throws(() => createFullscreenMonitor({ ...callbacks, helperPath, parentPid }), TypeError);
  }
  assert.throws(() => createFullscreenMonitor({ helperPath }), TypeError);
});
