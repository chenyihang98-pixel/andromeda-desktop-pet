'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMotionState, setMotionMode, syncMotionBounds, throwMotion, stepMotion } = require('../src/motion.cjs');
const area = { x: -1200, y: -200, width: 1200, height: 800 };
const bounds = { x: -600, y: 0, width: 192, height: 208 };
function inside(rect, workArea = area) {
  assert.ok(rect.x >= workArea.x && rect.y >= workArea.y);
  assert.ok(rect.x + rect.width <= workArea.x + workArea.width);
  assert.ok(rect.y + rect.height <= workArea.y + workArea.height);
}

test('movement defaults off and all suppression reasons take priority without OS effects', () => {
  const original = createMotionState(bounds);
  assert.equal(stepMotion(original, { deltaMs: 500, workArea: area }).moved, false);
  for (const reason of ['hidden', 'paused', 'dragging', 'fullscreen', 'reducedMotion']) {
    const moving = throwMotion(setMotionMode(original, 'toss'), { velocityX: 500, velocityY: -300 });
    const result = stepMotion(moving, { deltaMs: 500, workArea: area, [reason]: true });
    assert.deepEqual(result.bounds, bounds); assert.equal(result.state.active, false); assert.equal(result.state.velocityX, 0);
  }
  assert.deepEqual(original, createMotionState(bounds));
});

test('roam distance respects elapsed time and remains bounded at negative-coordinate edges', () => {
  const initial = createMotionState(bounds, { mode: 'roam' });
  const once = stepMotion(initial, { deltaMs: 500, workArea: area });
  let state = initial;
  for (let i = 0; i < 5; i++) state = stepMotion(state, { deltaMs: 100, workArea: area }).state;
  assert.ok(Math.abs(state.x - once.state.x) < 0.001); assert.equal(once.bounds.x, bounds.x + 16);
  state = createMotionState({ ...bounds, x: -193 }, { mode: 'roam' });
  for (let i = 0; i < 100; i++) { const result = stepMotion(state, { deltaMs: 250, workArea: area }); inside(result.bounds); state = result.state; }
});

test('follow approaches the pointer without covering it or crossing another monitor', () => {
  let state = createMotionState(bounds, { mode: 'follow' });
  const pointer = { x: -250, y: 100 };
  for (let i = 0; i < 100; i++) { const result = stepMotion(state, { deltaMs: 100, workArea: area, pointer }); inside(result.bounds); state = result.state; }
  assert.ok(Math.hypot(pointer.x - state.x - state.width / 2, pointer.y - state.y - state.height / 2) >= 95.9);
  const before = { ...state }; const otherScreen = stepMotion(state, { deltaMs: 1000, workArea: area, pointer: { x: 100, y: 100 } });
  assert.equal(otherScreen.reason, 'pointer-outside-work-area'); assert.equal(otherScreen.state.x, before.x);
});

test('toss is explicitly triggered, bounces inside the work area and settles on the floor', () => {
  let state = createMotionState(bounds, { mode: 'toss' });
  assert.equal(stepMotion(state, { deltaMs: 500, workArea: area }).moved, false);
  state = throwMotion(state, { velocityX: 1700, velocityY: -1200 });
  let touchedFloor = false;
  for (let i = 0; i < 300; i++) {
    const result = stepMotion(state, { deltaMs: 50, workArea: area }); inside(result.bounds); state = result.state;
    touchedFloor ||= result.bounds.y + result.bounds.height === area.y + area.height;
  }
  assert.equal(touchedFloor, true); assert.equal(state.active, false); assert.equal(state.velocityY, 0);
  assert.equal(Math.round(state.y), area.y + area.height - bounds.height);
});

test('long clock gaps do not teleport and work areas too small are reported unsupported', () => {
  const moving = createMotionState(bounds, { mode: 'roam' });
  const resumed = stepMotion(moving, { deltaMs: 60_000, workArea: area }); assert.equal(resumed.moved, false); assert.equal(resumed.reason, 'suspend-gap');
  const tiny = stepMotion(moving, { deltaMs: 100, workArea: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(tiny.supported, false); assert.equal(tiny.moved, false);
  const moved = syncMotionBounds(moving, { ...bounds, x: -1000 }); assert.equal(moved.x, -1000); assert.equal(moving.x, -600);
});

test('motion rejects invalid mode, unbounded velocity, negative elapsed time and coerced flags', () => {
  const initial = createMotionState(bounds);
  assert.throws(() => setMotionMode(initial, 'walk-over-apps'));
  assert.throws(() => throwMotion(initial, { velocityX: Infinity, velocityY: 0 }));
  assert.throws(() => stepMotion(initial, { deltaMs: -1, workArea: area }));
  assert.throws(() => stepMotion(initial, { deltaMs: 1, workArea: area, hidden: 'yes' }));
});

test('fractional work-area boundaries round inward rather than leaking into an adjacent monitor', () => {
  const fractional = { x: -1200.5, y: -200.5, width: 1200, height: 800 };
  const state = createMotionState({ ...bounds, x: -192.5, y: 391.5 }, { mode: 'roam' });
  const result = stepMotion(state, { deltaMs: 100, workArea: fractional });
  inside(result.bounds, fractional); assert.ok(Number.isInteger(result.bounds.x)); assert.ok(Number.isInteger(result.bounds.y));
});
