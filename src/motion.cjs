'use strict';

// Pure, opt-in work-area motion. All coordinates are DIP; the host owns OS calls.
const MOVEMENT_MODES = Object.freeze(['off', 'roam', 'follow', 'toss']);
const ROAM_SPEED = 32;
const FOLLOW_DISTANCE = 96;
const MAX_FOLLOW_SPEED = 160;
const GRAVITY = 900;
const MAX_GAP_MS = 1000;
const MAX_SUBSTEP_MS = 16;
const MAX_SPEED = 2000;

function finite(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError('无效的移动数值');
  return value;
}
function rectangle(value) {
  if (!value || typeof value !== 'object') throw new TypeError('需要窗口矩形');
  return { x: finite(value.x, -10_000_000, 10_000_000), y: finite(value.y, -10_000_000, 10_000_000),
    width: finite(value.width, 1, 10_000_000), height: finite(value.height, 1, 10_000_000) };
}
function mode(value) { if (!MOVEMENT_MODES.includes(value)) throw new TypeError('不支持的移动模式'); return value; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function createMotionState(bounds, { mode: movementMode = 'off', velocityX = 0, velocityY = 0, direction = 1 } = {}) {
  if (![1, -1].includes(direction)) throw new TypeError('方向必须为 -1 或 1');
  return { ...rectangle(bounds), mode: mode(movementMode), velocityX: finite(velocityX, -MAX_SPEED, MAX_SPEED),
    velocityY: finite(velocityY, -MAX_SPEED, MAX_SPEED), direction, active: false };
}
function checkedState(value) {
  const result = createMotionState(value, value);
  if (typeof value.active !== 'boolean') throw new TypeError('移动状态无效');
  result.active = value.active;
  return result;
}
function setMotionMode(value, movementMode) {
  const state = checkedState(value);
  return { ...state, mode: mode(movementMode), velocityX: 0, velocityY: 0, active: false };
}
function syncMotionBounds(value, bounds) {
  return { ...checkedState(value), ...rectangle(bounds) };
}
function throwMotion(value, { velocityX, velocityY }) {
  const state = checkedState(value);
  finite(velocityX, -MAX_SPEED, MAX_SPEED); finite(velocityY, -MAX_SPEED, MAX_SPEED);
  if (state.mode !== 'toss') return state;
  return { ...state, velocityX, velocityY, active: true };
}
function stepMotion(value, { deltaMs, workArea, pointer, hidden = false, paused = false, dragging = false,
  fullscreen = false, reducedMotion = false } = {}) {
  const state = checkedState(value), suppliedArea = rectangle(workArea);
  // Round inward, like BrowserWindow geometry: fractional work areas must never leak a pixel.
  const area = { x: Math.ceil(suppliedArea.x), y: Math.ceil(suppliedArea.y),
    width: Math.floor(suppliedArea.x + suppliedArea.width) - Math.ceil(suppliedArea.x),
    height: Math.floor(suppliedArea.y + suppliedArea.height) - Math.ceil(suppliedArea.y) };
  finite(deltaMs, 0, 86_400_000);
  if ([hidden, paused, dragging, fullscreen, reducedMotion].some(flag => typeof flag !== 'boolean')) throw new TypeError('移动暂停标志无效');
  const initial = rectangle(state);
  function result(reason, supported = true) {
    const bounds = { x: Math.round(state.x), y: Math.round(state.y), width: state.width, height: state.height };
    return { state, bounds, moved: bounds.x !== Math.round(initial.x) || bounds.y !== Math.round(initial.y),
      action: state.active && Math.abs(state.velocityX) >= 1 ? state.velocityX < 0 ? 'move-left' : 'move-right' : 'idle', supported, reason };
  }
  function halt(reason, supported = true) {
    state.velocityX = 0; state.velocityY = 0; state.active = false;
    return result(reason, supported);
  }
  if (state.width > area.width || state.height > area.height) return halt('work-area-too-small', false);
  // Paused/hidden hosts do not move. Monitor topology/clamping remains a separate host responsibility.
  if (hidden || paused || dragging || fullscreen || reducedMotion) return halt('suppressed');
  if (state.mode === 'off') return halt('disabled');
  if (deltaMs > MAX_GAP_MS) return halt('suspend-gap');
  const maxX = Math.floor(area.x + area.width - state.width), maxY = Math.floor(area.y + area.height - state.height);
  state.x = clamp(state.x, area.x, maxX); state.y = clamp(state.y, area.y, maxY);
  if (state.mode === 'follow') {
    if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return halt('no-pointer');
    if (pointer.x < area.x || pointer.x >= area.x + area.width || pointer.y < area.y || pointer.y >= area.y + area.height) return halt('pointer-outside-work-area');
  }
  if (!deltaMs) return result('zero-delta');
  if (state.mode === 'toss' && !state.active) return result('waiting-for-throw');
  let remaining = deltaMs;
  while (remaining > 0) {
    const dt = Math.min(remaining, MAX_SUBSTEP_MS) / 1000;
    remaining -= dt * 1000;
    if (state.mode === 'roam') {
      state.active = maxX > area.x;
      state.velocityX = state.active ? state.direction * ROAM_SPEED : 0; state.velocityY = 0;
      state.x += state.velocityX * dt;
      if (state.active && state.x >= maxX) { state.x = maxX; state.direction = -1; state.velocityX = -ROAM_SPEED; }
      if (state.active && state.x <= area.x) { state.x = area.x; state.direction = 1; state.velocityX = ROAM_SPEED; }
    } else if (state.mode === 'follow') {
      const dx = pointer.x - (state.x + state.width / 2), dy = pointer.y - (state.y + state.height / 2), distance = Math.hypot(dx, dy);
      const speed = distance > FOLLOW_DISTANCE ? Math.min(MAX_FOLLOW_SPEED, (distance - FOLLOW_DISTANCE) * 2) : 0;
      state.active = speed > 0.5;
      state.velocityX = distance ? dx / distance * speed : 0; state.velocityY = distance ? dy / distance * speed : 0;
      state.x = clamp(state.x + state.velocityX * dt, area.x, maxX); state.y = clamp(state.y + state.velocityY * dt, area.y, maxY);
    } else {
      const grounded = state.y >= maxY - 0.01 && Math.abs(state.velocityY) < 30;
      const gravity = grounded ? 0 : GRAVITY;
      if (grounded) { state.y = maxY; state.velocityY = 0; }
      state.x += state.velocityX * dt;
      state.y += state.velocityY * dt + 0.5 * gravity * dt * dt;
      state.velocityY += gravity * dt;
      state.velocityX *= Math.exp(-(grounded ? 5 : 0.8) * dt);
      if (state.x < area.x) { state.x = area.x; state.velocityX = Math.abs(state.velocityX) * 0.55; }
      if (state.x > maxX) { state.x = maxX; state.velocityX = -Math.abs(state.velocityX) * 0.55; }
      if (state.y < area.y) { state.y = area.y; state.velocityY = Math.abs(state.velocityY) * 0.45; }
      if (state.y > maxY) {
        state.y = maxY; state.velocityY = Math.abs(state.velocityY) < 60 ? 0 : -Math.abs(state.velocityY) * 0.4;
      }
      if (Math.abs(state.velocityX) < 3 && state.y >= maxY - 0.01 && Math.abs(state.velocityY) < 30) {
        state.velocityX = 0; state.velocityY = 0; state.active = false; break;
      }
    }
  }
  state.x = clamp(state.x, area.x, maxX); state.y = clamp(state.y, area.y, maxY);
  return result('advanced');
}

module.exports = { MOVEMENT_MODES, createMotionState, setMotionMode, syncMotionBounds, throwMotion, stepMotion };
