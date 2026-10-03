import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as animation from '../src/animation.mjs';

const source = readFileSync(new URL('../src/pet.mjs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
const importLine = /^import \{ACTIONS, frameAt, neutralDelay, gazeCell, cropRect\} from '\.\/animation\.mjs';\n/;
assert.match(source, importLine, 'Update the renderer adapter if its imports change');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Execute the real renderer with its real pure animation functions, replacing
// only browser/native boundaries and the clock. These are behavioral adapter
// tests, not native Electron, visual rendering, or Windows desktop validation.
const runRenderer = new AsyncFunction(
  'dependencies', 'window', 'document', 'matchMedia', 'fetch', 'Image',
  'performance', 'setTimeout', 'clearTimeout', 'console',
  `const {ACTIONS, frameAt, neutralDelay, gazeCell, cropRect} = dependencies;\n${source.replace(importLine, '')}`,
);

function eventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(name, fn) {
      const group = listeners.get(name) || [];
      group.push(fn); listeners.set(name, group);
    },
    emit(name, event = {}) {
      for (const fn of listeners.get(name) || []) fn(event);
    },
  }, extra);
}

async function createRenderer({motion = 'quiet', gaze = false, reduced = false, apiAvailable = true, failure = null} = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), calls = [], draws = [], errors = [];
  const classes = new Set();
  const canvas = eventTarget({
    width: 192, height: 208, dataset: {},
    classList: {add: (name) => classes.add(name), remove: (name) => classes.delete(name)},
    getContext: () => ({clearRect() {}, drawImage: (...args) => draws.push(args)}),
    getBoundingClientRect: () => ({left: 0, top: 0, width: 192, height: 208}),
    setPointerCapture(id) { calls.push(['capture', id]); },
  });
  const button = eventTarget(), error = {hidden: true};
  const elements = {'#pet': canvas, '#settings-button': button, '#error': error};
  const document = eventTarget({hidden: false, querySelector: (selector) => elements[selector]});
  const media = eventTarget({matches: reduced});
  let state = {settings: {motion, gaze, scale: 1.25, alwaysOnTop: true}};
  let onState, onAction;
  const api = {
    onState(fn) { onState = fn; return () => {}; },
    onAction(fn) { onAction = fn; return () => {}; },
    async getState() {
      if (failure === 'state') throw new Error('simulated IPC failure');
      return state;
    },
    showSettings() { calls.push(['settings']); },
    startDrag() { calls.push(['startDrag']); },
    drag() { calls.push(['drag']); },
    endDrag() { calls.push(['endDrag']); },
  };
  const window = eventTarget({andromeda: apiAvailable ? api : undefined});
  const setTimeout = (fn, delay) => {
    timers.set(++serial, {fn, due: now + delay}); return serial;
  };
  const clearTimeout = (id) => timers.delete(id);
  const clock = {
    pending: () => timers.size,
    nextDelay: () => timers.size ? Math.min(...[...timers.values()].map((timer) => timer.due - now)) : null,
    advance(ms) {
      const end = now + ms; let count = 0;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        assert.ok(++count < 1000, 'Renderer scheduled a runaway timer loop');
        now = timer.due; timers.delete(id); timer.fn();
      }
      now = end;
    },
  };
  await runRenderer(
    {...animation, neutralDelay: (value) => animation.neutralDelay(value, () => 0)},
    window, document, () => media,
    async () => {
      if (failure === 'fetch') throw new Error('simulated asset fetch failure');
      return {json: async () => manifest};
    },
    class FakeImage {
      async decode() { if (failure === 'image') throw new Error('simulated image decode failure'); }
    },
    {now: () => now}, setTimeout, clearTimeout,
    {error: (...args) => errors.push(args)},
  );
  return {
    canvas, button, error, document, media, window, clock, calls, draws, errors, classes,
    action: (value) => onAction?.(value),
    update(patch) { state = {settings: {...state.settings, ...patch}}; onState?.(state); },
    cell: () => [Number(canvas.dataset.row), Number(canvas.dataset.column)],
    visible(value) { document.hidden = !value; document.emit('visibilitychange'); },
    reduce(value) { media.matches = value; media.emit('change'); },
  };
}

test('renderer stays neutral for the quiet hold, plays idle once, then rearms', async () => {
  const r = await createRenderer();
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.nextDelay(), 45000);
  const initialDraws = r.draws.length;
  r.clock.advance(44999);
  assert.equal(r.draws.length, initialDraws);
  r.clock.advance(1 + 420);
  assert.deepEqual(r.cell(), [0, 1]);
  r.clock.advance(1230);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 1);
  assert.equal(r.clock.nextDelay(), 45000);
});

test('renderer still mode has no autonomous timer; all manual actions finish once', async () => {
  const r = await createRenderer({motion: 'still'});
  assert.equal(r.clock.pending(), 0);
  for (const [action, name] of Object.entries(animation.ACTIONS)) {
    const entry = manifest.animations[name];
    r.action(action);
    assert.deepEqual(r.cell(), [entry.row, 0]);
    assert.equal(r.clock.pending(), 1);
    r.clock.advance(entry.durationsMs.reduce((sum, duration) => sum + duration, 0) * 1.5);
    assert.deepEqual(r.cell(), [0, 0]);
    assert.equal(r.clock.pending(), 0);
  }
  r.action('unsupported');
  assert.equal(r.clock.pending(), 0);
});

test('renderer settings updates replace the old schedule and repeated actions cancel old frames', async () => {
  const r = await createRenderer();
  r.update({motion: 'lively'});
  assert.equal(r.clock.nextDelay(), 12000);
  r.action('wave'); r.action('jump');
  assert.deepEqual(r.cell(), [4, 0]);
  assert.equal(r.clock.pending(), 1);
  r.clock.advance(210);
  assert.deepEqual(r.cell(), [4, 1]);
  r.update({motion: 'still'});
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0);
});

test('renderer gaze suppresses only idle scheduling and maps canvas coordinates', async () => {
  const r = await createRenderer({gaze: true});
  r.canvas.emit('pointerenter');
  assert.equal(r.clock.pending(), 0);
  r.canvas.emit('pointermove', {clientX: 192, clientY: 104});
  assert.deepEqual(r.cell(), [9, 4]);
  r.canvas.emit('pointermove', {clientX: 96, clientY: 0});
  assert.deepEqual(r.cell(), [9, 0]);
  r.canvas.emit('pointermove', {clientX: 96, clientY: 104});
  assert.deepEqual(r.cell(), [0, 0]);
  r.canvas.emit('pointerleave');
  assert.equal(r.clock.nextDelay(), 45000);
});

test('regression: gaze pointerenter cannot cancel an active action timer', async () => {
  const r = await createRenderer({gaze: true});
  r.action('wave');
  r.canvas.emit('pointerenter');
  assert.equal(r.clock.pending(), 1);
  r.clock.advance(210);
  assert.deepEqual(r.cell(), [3, 1]);
  r.canvas.emit('pointermove', {clientX: 192, clientY: 104});
  assert.deepEqual(r.cell(), [3, 1]);
  r.clock.advance(840);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0, 'Hovering with gaze enabled suppresses subsequent idle');
  r.canvas.emit('pointerleave');
  assert.equal(r.clock.nextDelay(), 45000);
});

test('reduced motion uses a 900ms static pose, preserved across gaze pointerenter', async () => {
  const r = await createRenderer({gaze: true, reduced: true});
  assert.equal(r.clock.pending(), 0);
  r.action('wave');
  assert.deepEqual(r.cell(), [3, 0]);
  r.canvas.emit('pointerenter');
  assert.equal(r.clock.nextDelay(), 900);
  r.canvas.emit('pointermove', {clientX: 192, clientY: 104});
  assert.deepEqual(r.cell(), [3, 0]);
  r.clock.advance(899);
  assert.deepEqual(r.cell(), [3, 0]);
  r.clock.advance(1);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0);
  r.canvas.emit('pointerleave');
  r.reduce(false);
  assert.equal(r.clock.nextDelay(), 45000);
  r.action('jump'); r.reduce(true);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0);
});

test('hidden renderer cancels frames and ignores actions; showing resets to neutral', async () => {
  const r = await createRenderer();
  r.action('wave'); r.visible(false);
  assert.equal(r.clock.pending(), 0);
  const before = r.draws.length;
  r.action('jump'); r.clock.advance(120000);
  assert.equal(r.draws.length, before);
  r.visible(true);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.nextDelay(), 45000);
});

test('dragging cancels playback, captures pointer, sends bounded bridge methods, and rearms on release', async () => {
  const r = await createRenderer({gaze: true});
  r.action('wave');
  r.canvas.emit('pointerdown', {button: 2, pointerId: 10});
  assert.equal(r.calls.length, 0);
  r.canvas.emit('pointerdown', {button: 0, pointerId: 11});
  assert.deepEqual(r.calls, [['capture', 11], ['startDrag']]);
  assert.ok(r.classes.has('dragging'));
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0);
  r.canvas.emit('pointermove', {clientX: 190, clientY: 100});
  assert.deepEqual(r.calls.at(-1), ['drag']);
  r.action('jump');
  assert.deepEqual(r.cell(), [0, 0]);
  r.canvas.emit('pointerup'); r.canvas.emit('lostpointercapture');
  assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 1);
  assert.equal(r.classes.has('dragging'), false);
  assert.equal(r.clock.nextDelay(), 45000);
});

test('pointer cancellation, lost capture, and blur each finish an interrupted drag once', async () => {
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    const r = await createRenderer();
    r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
    (event === 'blur' ? r.window : r.canvas).emit(event);
    assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 1, event);
    assert.equal(r.classes.has('dragging'), false, event);
    assert.equal(r.clock.pending(), 1, event);
  }
});

test('settings can be opened by double-click, button, Enter, and Space', async () => {
  const r = await createRenderer();
  r.canvas.emit('dblclick'); r.button.emit('click');
  let prevented = 0;
  for (const key of ['Enter', ' ', 'Escape']) r.canvas.emit('keydown', {key, preventDefault() { prevented++; }});
  assert.equal(r.calls.filter(([name]) => name === 'settings').length, 4);
  assert.equal(prevented, 2);
});

test('asset, image, and initial IPC failures expose the local error instead of an uncaught rejection', async () => {
  for (const failure of ['fetch', 'image', 'state']) {
    const r = await createRenderer({failure});
    assert.equal(r.error.hidden, false, failure);
    assert.equal(r.errors.length, 1, failure);
    assert.equal(r.clock.pending(), 0, failure);
  }
});

test('browser-only renderer fallback schedules quiet playback without the native bridge', async () => {
  const r = await createRenderer({apiAvailable: false});
  assert.equal(r.error.hidden, true);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.nextDelay(), 45000);
  r.button.emit('click');
  assert.equal(r.calls.length, 0);
});
