'use strict';

const { spawn: spawnProcess } = require('node:child_process');
const path = require('node:path');

const HEARTBEAT_TIMEOUT_MS = 3_000;
const MAX_LINE_BYTES = 1_024;
const MAX_CHUNK_BYTES = 65_536;
const MIN_INT32 = -2_147_483_648;
const MAX_INT32 = 2_147_483_647;

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parseHeartbeat(line) {
  let value;
  try { value = JSON.parse(line.toString('utf8')); } catch { throw new Error('invalid-data'); }
  if (value?.version !== 1 || typeof value.fullscreen !== 'boolean'
    || !hasKeys(value, value.fullscreen ? ['version', 'fullscreen', 'monitor'] : ['version', 'fullscreen'])) {
    throw new Error('invalid-data');
  }
  if (!value.fullscreen) return null;
  const bounds = value.monitor;
  if (!hasKeys(bounds, ['x', 'y', 'width', 'height'])
    || !Object.values(bounds).every(number => Number.isInteger(number) && number >= MIN_INT32 && number <= MAX_INT32)
    || bounds.width <= 0 || bounds.height <= 0
    || bounds.x + bounds.width > MAX_INT32 || bounds.y + bounds.height > MAX_INT32) {
    throw new Error('invalid-data');
  }
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

/**
 * Supervise only the bundled, fixed-path Windows helper. Each valid heartbeat
 * calls onChange with physical monitor bounds, or null when not fullscreen.
 * Repeated heartbeats are intentional: display mapping and tray availability
 * can change while the same foreground application remains fullscreen.
 * Failure and intentional stop fail open with null. There is no retry loop.
 */
function createFullscreenMonitor({
  helperPath, parentPid = process.pid, spawn = spawnProcess,
  onChange, onError, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout,
} = {}) {
  if (typeof helperPath !== 'string' || !path.isAbsolute(helperPath) || helperPath.includes('\0')) {
    throw new TypeError('A fixed absolute fullscreen helper path is required');
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid > 4_294_967_295) {
    throw new TypeError('A valid parent process ID is required');
  }
  if (![spawn, onChange, onError, schedule, cancel].every(value => typeof value === 'function')) {
    throw new TypeError('Fullscreen monitor callbacks must be functions');
  }

  let current = null;
  let generation = 0;
  const silentError = () => {};

  function active(run) { return current === run && !run.closed; }

  function cleanup(run) {
    run.closed = true;
    cancel(run.watchdog);
    run.watchdog = null;
    run.pending = Buffer.alloc(0);
    const child = run.child;
    if (!child) return;
    // A killed process/closed pipe can report a delayed error after teardown.
    // Keep only a harmless listener for those errors, never application callbacks.
    for (const emitter of [child, child.stdout, child.stdin]) {
      if (emitter?.on) emitter.on('error', silentError);
    }
    for (const [emitter, event, listener] of run.listeners) emitter.removeListener(event, listener);
    run.listeners.length = 0;
    try { child.stdin?.end(); } catch { /* Already closed. */ }
    try { child.stdout?.destroy(); } catch { /* Already closed. */ }
    try { child.kill(); } catch { /* Already exited. */ }
  }

  function fail(run, reason) {
    if (!active(run)) return;
    current = null;
    cleanup(run);
    onChange(null);
    // A callback may intentionally stop/restart the monitor. Do not deliver an
    // obsolete error into that new session, and never expose helper output.
    if (generation === run.generation) onError(reason);
  }

  function armWatchdog(run) {
    cancel(run.watchdog);
    run.watchdog = schedule(() => fail(run, 'heartbeat-timeout'), HEARTBEAT_TIMEOUT_MS);
    run.watchdog?.unref?.();
  }

  function consume(run, chunk) {
    if (!active(run)) return;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { fail(run, 'invalid-data'); return; }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (bytes.length > MAX_CHUNK_BYTES) { fail(run, 'invalid-data'); return; }
    let offset = 0;
    while (offset < bytes.length && active(run)) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (run.pending.length + segment.length > MAX_LINE_BYTES) { fail(run, 'invalid-data'); return; }
      const line = run.pending.length ? Buffer.concat([run.pending, segment]) : segment;
      if (newline === -1) { run.pending = Buffer.from(line); return; }
      run.pending = Buffer.alloc(0);
      let bounds;
      try { bounds = parseHeartbeat(line); } catch { fail(run, 'invalid-data'); return; }
      armWatchdog(run);
      onChange(bounds);
      offset = newline + 1;
    }
  }

  function listen(run, emitter, event, callback) {
    emitter.on(event, callback);
    run.listeners.push([emitter, event, callback]);
  }

  function start() {
    if (current) return true;
    const run = { generation: ++generation, child: null, closed: false, pending: Buffer.alloc(0), watchdog: null, listeners: [] };
    current = run;
    try {
      run.child = spawn(helperPath, ['--parent-pid', String(parentPid)], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      if (!run.child?.on || !run.child.stdout?.on || !run.child.stdin?.on) throw new Error('unavailable-pipes');
      listen(run, run.child, 'error', () => fail(run, 'spawn-failed'));
      listen(run, run.child, 'exit', () => fail(run, 'helper-exited'));
      listen(run, run.child, 'close', () => fail(run, 'helper-exited'));
      listen(run, run.child.stdout, 'error', () => fail(run, 'helper-output-error'));
      listen(run, run.child.stdin, 'error', () => fail(run, 'helper-output-error'));
      listen(run, run.child.stdout, 'data', chunk => consume(run, chunk));
      listen(run, run.child.stdout, 'end', () => fail(run, 'helper-exited'));
      armWatchdog(run);
    } catch { fail(run, 'spawn-failed'); return false; }
    return true;
  }

  function stop() {
    ++generation;
    const run = current;
    if (!run) return;
    current = null;
    cleanup(run);
    onChange(null);
  }

  return Object.freeze({ start, stop });
}

module.exports = { createFullscreenMonitor, HEARTBEAT_TIMEOUT_MS, MAX_LINE_BYTES, MAX_CHUNK_BYTES };
