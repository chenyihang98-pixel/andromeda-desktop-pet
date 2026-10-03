import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as animation from '../src/animation.mjs';

const source = readFileSync(new URL('../src/pet.mjs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
const importLine = /^import \{ACTIONS, frameAt, neutralDelay, gazeCell, cropRect\} from '\.\/animation\.mjs';\r?\n/;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Execute the real renderer with its real pure animation functions, replacing
// only browser/native boundaries and the clock. These are behavioral adapter
// tests, not native Electron, visual rendering, or Windows desktop validation.
function compileRenderer(sourceText) {
  assert.match(sourceText, importLine, 'Update the renderer adapter if its imports change');
  return new AsyncFunction(
    'dependencies', 'window', 'document', 'matchMedia', 'fetch', 'Image',
    'performance', 'setTimeout', 'clearTimeout', 'console',
    `const {ACTIONS, frameAt, neutralDelay, gazeCell, cropRect} = dependencies;\n${sourceText.replace(importLine, '')}`,
  );
}
const runRenderer = compileRenderer(source);

test('renderer adapter accepts LF and CRLF checkouts while rejecting changed imports', () => {
  for (const newline of ['\n', '\r\n']) {
    const checkout = source.replace(/\r?\n/g, newline);
    assert.equal(typeof compileRenderer(checkout), 'function');
    assert.throws(() => compileRenderer(checkout.replace('./animation.mjs', './other.mjs')),
      /Update the renderer adapter if its imports change/);
  }
});

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

async function createRenderer({motion = 'quiet', gaze = false, globalGaze = false, reduced = false, apiAvailable = true, failure = null, dock = null, visible = true, apiFailure = null} = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), calls = [], draws = [], errors = [];
  const classes = new Set();
  const capturedPointers = new Set();
  const canvas = eventTarget({
    width: 192, height: 208, dataset: {},
    classList: {add: (name) => classes.add(name), remove: (name) => classes.delete(name)},
    getContext: () => ({clearRect() {}, drawImage: (...args) => draws.push(args)}),
    getBoundingClientRect: () => ({left: 0, top: 0, width: 192, height: 208}),
    setPointerCapture(id) { capturedPointers.add(id); calls.push(['capture', id]); },
    hasPointerCapture(id) { return capturedPointers.has(id); },
    releasePointerCapture(id) {
      capturedPointers.delete(id); calls.push(['release', id]);
      this.emit('lostpointercapture', {pointerId: id});
    },
  });
  const bodyClasses = new Set();
  const body = {dataset: {}, classList: {toggle(name, value) { if (value) bodyClasses.add(name); else bodyClasses.delete(name); }}};
  const button = eventTarget(), handle = eventTarget(), indicator = {}, error = {hidden: true};
  const elements = {'#pet': canvas, '#settings-button': button, '#dock-handle': handle, '#dock-indicator': indicator, '#error': error};
  const document = eventTarget({body, hidden: false, querySelector: (selector) => elements[selector]});
  const media = eventTarget({matches: reduced});
  let state = {settings: {motion, gaze, globalGaze, edgeDock: true, clickThrough: false, scale: 1.25, alwaysOnTop: true}, visible, dock, trayAvailable: true, persistenceError: null, version: '0.2.0', clickThroughActive: false};
  let onState, onAction, onGaze;
  const record = (name) => { calls.push([name]); if (apiFailure === name) return Promise.reject(new Error('simulated command failure')); }; 
  const api = {
    onState(fn) { onState = fn; return () => {}; },
    onAction(fn) { onAction = fn; return () => {}; },
    onGaze(fn) { onGaze = fn; return () => {}; },
    async getState() {
      if (failure === 'state') throw new Error('simulated IPC failure');
      return state;
    },
    showSettings() { return record('settings'); },
    startDrag() { return record('startDrag'); },
    drag() { return record('drag'); },
    endDrag() { return record('endDrag'); },
    cancelDrag() { return record('cancelDrag'); },
    undock() { return record('undock'); },
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
    canvas, button, handle, indicator, bodyClasses, error, document, media, window, clock, calls, draws, errors, classes,
    action: (value) => onAction?.(value),
    update(patch) { state = {...state, settings: {...state.settings, ...patch}}; onState?.(state); },
    state(patch) { state = {...state, ...patch}; onState?.(state); },
    gaze: (point) => onGaze?.(point),
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
  r.canvas.emit('pointermove', {pointerId: 11, clientX: 190, clientY: 100});
  assert.deepEqual(r.calls.at(-1), ['drag']);
  r.action('jump');
  assert.deepEqual(r.cell(), [0, 0]);
  r.canvas.emit('pointerup', {pointerId: 11}); r.canvas.emit('lostpointercapture', {pointerId: 11});
  assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 1);
  assert.equal(r.classes.has('dragging'), false);
  assert.equal(r.clock.nextDelay(), 45000);
});

test('pointer cancellation, lost capture, and blur cancel instead of committing a dock', async () => {
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    const r = await createRenderer();
    r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
    (event === 'blur' ? r.window : r.canvas).emit(event, {pointerId: 1});
    assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 0, event);
    assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 1, event);
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

test('metadata-only and size/always-on-top settings updates preserve quiet deadlines and active frames', async () => {
  const r = await createRenderer();
  r.clock.advance(5000);
  r.state({persistenceError: 'disk full', trayAvailable: false});
  r.update({scale: 1.5, alwaysOnTop: false, edgeDock: false, clickThrough: true});
  assert.equal(r.clock.nextDelay(), 40000);
  r.action('wave'); r.clock.advance(210);
  r.state({persistenceError: null, trayAvailable: true, clickThroughActive: true});
  assert.deepEqual(r.cell(), [3, 1]);
  assert.equal(r.clock.nextDelay(), 210);
  r.clock.advance(840);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.nextDelay(), 45000);
});

test('global gaze supersedes local gaze, has no idle timer, and resumes on the next sample after an action', async () => {
  const r = await createRenderer({gaze: true, globalGaze: true});
  assert.equal(r.clock.pending(), 0);
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [9, 4]);
  r.canvas.emit('pointerenter');
  r.canvas.emit('pointermove', {clientX: 96, clientY: 0});
  r.canvas.emit('pointerleave');
  assert.deepEqual(r.cell(), [9, 4]);
  r.action('wave');
  r.gaze({x: -100, y: 0});
  r.clock.advance(210);
  r.canvas.emit('pointerleave');
  assert.deepEqual(r.cell(), [3, 1]);
  r.clock.advance(840);
  assert.deepEqual(r.cell(), [0, 0]);
  r.gaze({x: -100, y: 0});
  assert.deepEqual(r.cell(), [10, 4]);
  assert.equal(r.clock.pending(), 0);
  r.update({globalGaze: false});
  assert.equal(r.clock.nextDelay(), 45000);
  r.canvas.emit('pointerenter');
  r.canvas.emit('pointermove', {clientX: 96, clientY: 0});
  assert.deepEqual(r.cell(), [9, 0]);
});

test('global gaze rejects invalid payloads and respects reduced motion, hidden state and dragging', async () => {
  const r = await createRenderer({globalGaze: true});
  for (const value of [null, undefined, {x: NaN, y: 0}, {x: 0, y: Infinity}, {x: '100', y: 0}]) r.gaze(value);
  assert.deepEqual(r.cell(), [0, 0]);
  r.reduce(true); r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [0, 0]);
  r.action('wave'); r.gaze({x: 100, y: 0});
  r.canvas.emit('pointerleave');
  assert.deepEqual(r.cell(), [3, 0]);
  r.clock.advance(900); r.reduce(false);
  r.state({visible: false});
  const before = r.draws.length;
  r.gaze({x: 100, y: 0}); r.action('jump');
  assert.equal(r.draws.length, before);
  assert.equal(r.clock.pending(), 0);
  r.state({visible: true});
  r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [0, 0]);
  r.canvas.emit('pointerup', {pointerId: 1});
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [9, 4]);
});

test('collapsed star is the only control, stops animation and gaze, and supports click, Enter and Escape', async () => {
  const r = await createRenderer({globalGaze: true});
  r.action('wave');
  r.state({dock: {edge: 'left', collapsed: true}});
  assert.equal(r.canvas.hidden, true);
  assert.equal(r.button.hidden, true);
  assert.equal(r.handle.hidden, false);
  assert.equal(r.indicator.hidden, true);
  assert.equal(r.bodyClasses.has('collapsed'), true);
  assert.equal(r.document.body.dataset.dock, 'left');
  assert.equal(r.clock.pending(), 0);
  const before = r.draws.length;
  r.action('jump'); r.gaze({x: 100, y: 0}); r.clock.advance(120000);
  assert.equal(r.draws.length, before);
  r.handle.emit('click');
  let prevented = 0;
  r.handle.emit('keydown', {key: 'Enter', preventDefault() { prevented++; }});
  r.document.emit('keydown', {key: 'Escape', preventDefault() { prevented++; }});
  assert.equal(r.calls.filter(([name]) => name === 'undock').length, 3);
  assert.equal(prevented, 2);
  r.state({dock: {edge: 'left', collapsed: false}});
  assert.equal(r.canvas.hidden, false);
  assert.equal(r.button.hidden, false);
  assert.equal(r.handle.hidden, true);
  assert.equal(r.indicator.hidden, false);
  assert.match(r.canvas.title, /Esc/);
  assert.deepEqual(r.cell(), [0, 0]);
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [9, 4]);
});

test('collapsed startup, expanded reveal and undocking produce one calm schedule', async () => {
  const r = await createRenderer({dock: {edge: 'bottom', collapsed: true}});
  assert.equal(r.clock.pending(), 0);
  r.state({dock: {edge: 'bottom', collapsed: false}});
  assert.equal(r.clock.nextDelay(), 45000);
  r.clock.advance(2000);
  r.state({dock: {edge: 'bottom', collapsed: false}});
  assert.equal(r.clock.nextDelay(), 43000);
  r.state({dock: null});
  assert.equal(r.indicator.hidden, true);
  assert.equal(r.clock.pending(), 1);
  assert.equal(r.clock.nextDelay(), 45000);
  r.document.emit('keydown', {key: 'Escape', preventDefault() { throw new Error('Floating Escape must not be consumed'); }});
  assert.equal(r.calls.length, 0);
});

test('window hidden or dock collapse cancels an in-progress drag instead of finishing it', async () => {
  for (const update of [{visible: false}, {dock: {edge: 'top', collapsed: true}}]) {
    const r = await createRenderer();
    r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
    r.state(update);
    r.canvas.emit('lostpointercapture', {pointerId: 1});
    assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 1);
    assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 0);
    assert.equal(r.canvas.hasPointerCapture(1), false);
    assert.equal(r.clock.pending(), 0);
  }
});

test('rejected async UI commands are handled and expose a recoverable error', async () => {
  const r = await createRenderer({apiFailure: 'settings'});
  r.button.emit('click');
  await Promise.resolve();
  assert.equal(r.error.hidden, false);
  assert.match(r.error.textContent, /未能完成/);
  assert.equal(r.errors.length, 1);
  assert.equal(r.clock.pending(), 1, 'A command failure must not corrupt playback');
});

test('local gaze pointerleave cannot cancel a manual action or reduced-motion pose', async () => {
  for (const reduced of [false, true]) {
    const r = await createRenderer({gaze: true, reduced});
    r.action('wave');
    r.canvas.emit('pointerenter'); r.canvas.emit('pointerleave');
    assert.deepEqual(r.cell(), [3, 0]);
    assert.equal(r.clock.pending(), 1);
  }
});

test('global gaze avoids redrawing an unchanged pose on repeated native samples', async () => {
  const r = await createRenderer({globalGaze: true});
  r.gaze({x: 100, y: 0});
  const before = r.draws.length;
  for (let index = 0; index < 30; index++) r.gaze({x: 100 + index, y: 0});
  assert.equal(r.draws.length, before);
  assert.equal(r.clock.pending(), 0);
});

test('hiding or collapsing clears stale local hover so a reveal can resume quiet playback', async () => {
  for (const hidden of ['document', 'native', 'dock']) {
    const r = await createRenderer({gaze: true});
    r.canvas.emit('pointerenter');
    assert.equal(r.clock.pending(), 0);
    if (hidden === 'document') { r.visible(false); r.visible(true); }
    else if (hidden === 'native') { r.state({visible: false}); r.state({visible: true}); }
    else { r.state({dock: {edge: 'top', collapsed: true}}); r.state({dock: {edge: 'top', collapsed: false}}); }
    assert.equal(r.clock.nextDelay(), 45000, hidden);
  }
});

test('changing gaze preferences preserves a manual action until its normal completion', async () => {
  const r = await createRenderer();
  r.action('wave'); r.clock.advance(210);
  r.update({globalGaze: true, gaze: true});
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [3, 1]);
  assert.equal(r.clock.nextDelay(), 210);
  r.clock.advance(840);
  assert.deepEqual(r.cell(), [0, 0]);
  assert.equal(r.clock.pending(), 0);
  r.gaze({x: 100, y: 0});
  assert.deepEqual(r.cell(), [9, 4]);
});

test('unrelated pointers cannot move, finish, or cancel the pointer that owns a drag', async () => {
  const r = await createRenderer();
  r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
  r.canvas.emit('pointerdown', {button: 0, pointerId: 2});
  for (const event of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    r.canvas.emit(event, {pointerId: 2});
  }
  assert.deepEqual(r.calls, [['capture', 1], ['startDrag']]);
  assert.equal(r.classes.has('dragging'), true);
  assert.equal(r.canvas.hasPointerCapture(1), true);
  assert.equal(r.clock.pending(), 0);
  r.canvas.emit('pointermove', {pointerId: 1});
  r.canvas.emit('pointerup', {pointerId: 1});
  assert.deepEqual(r.calls.slice(2), [['drag'], ['release', 1], ['endDrag']]);
  assert.equal(r.canvas.hasPointerCapture(1), false);
  assert.equal(r.classes.has('dragging'), false);
  assert.equal(r.clock.pending(), 1);
});

test('cancel releases capture and delayed events from the old pointer cannot stop a new drag', async () => {
  const r = await createRenderer();
  r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
  r.window.emit('blur');
  assert.equal(r.canvas.hasPointerCapture(1), false);
  r.canvas.emit('pointerdown', {button: 0, pointerId: 2});
  for (const event of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    r.canvas.emit(event, {pointerId: 1});
  }
  assert.equal(r.classes.has('dragging'), true);
  assert.equal(r.canvas.hasPointerCapture(2), true);
  assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 1);
  assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 0);
  r.canvas.emit('pointercancel', {pointerId: 2});
  assert.equal(r.canvas.hasPointerCapture(2), false);
  assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 2);
  assert.equal(r.classes.has('dragging'), false);
  assert.equal(r.clock.pending(), 1);
});

test('capture and release failures still cancel once and allow a later drag', async () => {
  for (const method of ['setPointerCapture', 'releasePointerCapture']) {
    const r = await createRenderer();
    const original = r.canvas[method];
    r.canvas[method] = () => { throw new Error('Native capture unavailable'); };
    r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
    r.window.emit('blur');
    assert.equal(r.classes.has('dragging'), false, method);
    assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 1, method);
    assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 0, method);
    assert.equal(r.clock.pending(), 1, method);
    r.canvas[method] = original;
    r.canvas.emit('pointerdown', {button: 0, pointerId: 2});
    r.canvas.emit('pointerup', {pointerId: 2});
    assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 1, method);
    assert.equal(r.classes.has('dragging'), false, method);
  }
});

test('opening a context menu releases capture and a later pointer release cannot commit docking', async () => {
  const r = await createRenderer();
  r.canvas.emit('pointerdown', {button: 0, pointerId: 1});
  r.canvas.emit('pointermove', {pointerId: 1});
  r.document.emit('contextmenu', {preventDefault() { throw new Error('The native menu must remain available'); }});
  r.canvas.emit('pointerup', {pointerId: 1});
  assert.equal(r.canvas.hasPointerCapture(1), false);
  assert.equal(r.classes.has('dragging'), false);
  assert.equal(r.calls.filter(([name]) => name === 'cancelDrag').length, 1);
  assert.equal(r.calls.filter(([name]) => name === 'endDrag').length, 0);
  assert.equal(r.clock.pending(), 1);
});
