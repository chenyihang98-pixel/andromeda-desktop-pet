import {ACTIONS, frameAt, neutralDelay, gazeCell, cropRect} from './animation.mjs';
const api = window.andromeda;
const canvas = document.querySelector('#pet');
const settingsButton = document.querySelector('#settings-button');
const dockHandle = document.querySelector('#dock-handle');
const dockIndicator = document.querySelector('#dock-indicator');
const errorNotice = document.querySelector('#error');
const context = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let manifest, atlasImage;
let settings = {motion: 'quiet', gaze: false, globalGaze: false};
let visible = true, dock = null;
let timer, sequence, dragging = false, pointerOver = false, ready = false;
function cancelTimer() { clearTimeout(timer); timer = undefined; }
function paused() { return document.hidden || !visible || Boolean(dock?.collapsed); }
function reportError(error) {
  errorNotice.textContent = '这次操作未能完成，请从系统托盘打开设置后重试';
  errorNotice.hidden = Boolean(dock?.collapsed);
  console.error('Unable to complete pet action', error);
}
async function callAPI(method) {
  try { await api?.[method]?.(); } catch (error) { reportError(error); }
}
function draw(row = 0, column = 0) {
  if (!ready || paused()) return;
  if (canvas.dataset.row === String(row) && canvas.dataset.column === String(column)) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(atlasImage, ...cropRect(manifest.atlas, row, column), 0, 0, canvas.width, canvas.height);
  canvas.dataset.row = String(row); canvas.dataset.column = String(column);
}
function scheduleIdle() {
  cancelTimer();
  // Global gaze is a calm continuous pose: it replaces autonomous idle, never
  // explicit actions. The main process samples the cursor; no coordinates leave
  // this renderer. Local gaze remains a separate hover-only preference.
  if (paused() || dragging || settings.globalGaze || (settings.gaze && pointerOver) || reducedMotion.matches) return;
  const delay = neutralDelay(settings.motion);
  if (delay !== null) timer = setTimeout(() => play('idle'), delay);
}
function neutral() { sequence = undefined; draw(); scheduleIdle(); }
function tick() {
  if (!sequence || paused()) return;
  const frame = frameAt(manifest.animations[sequence.state], performance.now() - sequence.start, sequence.multiplier);
  if (!frame) { neutral(); return; }
  draw(frame.row, frame.column);
  timer = setTimeout(tick, Math.max(4, frame.remainingMs));
}
function play(state) {
  if (!ready || dragging || !manifest.animations[state] || paused()) return;
  cancelTimer();
  sequence = {state, start: performance.now(), multiplier: state === 'idle' ? manifest.desktopPlayback.idleSpeedMultiplier : 1.5};
  if (reducedMotion.matches) { draw(manifest.animations[state].row, 0); timer = setTimeout(neutral, 900); return; }
  tick();
}
function applyState(state) {
  if (!state?.settings) return;
  const nextSettings = {...settings, ...state.settings};
  const nextVisible = state.visible !== false;
  const nextDock = ['left', 'right', 'top', 'bottom'].includes(state.dock?.edge)
    ? {edge: state.dock.edge, collapsed: state.dock.collapsed === true} : null;
  const motionChanged = settings.motion !== nextSettings.motion;
  const gazeChanged = ['gaze', 'globalGaze'].some(key => settings[key] !== nextSettings[key]);
  const surfaceChanged = visible !== nextVisible || dock?.edge !== nextDock?.edge || dock?.collapsed !== nextDock?.collapsed;
  settings = nextSettings; visible = nextVisible; dock = nextDock;
  const collapsed = Boolean(dock?.collapsed);
  document.body.dataset.dock = dock?.edge || '';
  document.body.classList.toggle('collapsed', collapsed);
  canvas.hidden = collapsed; settingsButton.hidden = collapsed;
  dockHandle.hidden = !collapsed; dockIndicator.hidden = !dock || collapsed;
  canvas.title = dock ? '已停靠屏幕边缘 · 拖向屏幕内侧或按 Esc 解除停靠' : '拖动移动 · 双击打开设置';
  if (collapsed || !visible) pointerOver = false;
  if (collapsed) errorNotice.hidden = true;
  if ((collapsed || !visible) && dragging) finishDrag(true);
  // Position saves and persistence/tray updates can arrive mid-action. Do not
  // restart playback or postpone the quiet interval for those notifications.
  if (surfaceChanged || motionChanged || (gazeChanged && (!sequence || sequence.state === 'idle'))) neutral();
}
function finishDrag(cancelled = false) {
  if (!dragging) return;
  dragging = false; canvas.classList.remove('dragging');
  void callAPI(cancelled ? 'cancelDrag' : 'endDrag');
  neutral();
}
function canGaze() { return ready && !paused() && !dragging && !sequence && !reducedMotion.matches; }
function globalGaze(point) {
  if (!settings.globalGaze || !canGaze() || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
  const cell = gazeCell(point.x, point.y);
  draw(cell.row, cell.column);
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || paused() || dragging) return;
  dragging = true; cancelTimer(); sequence = undefined; draw(); canvas.classList.add('dragging');
  try { canvas.setPointerCapture(event.pointerId); } catch { finishDrag(true); return; }
  void callAPI('startDrag');
});
canvas.addEventListener('pointermove', event => {
  if (dragging) { void callAPI('drag'); return; }
  if (settings.gaze && !settings.globalGaze && canGaze()) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cell = gazeCell((event.clientX - rect.left - rect.width / 2) * 192 / rect.width, (event.clientY - rect.top - rect.height / 2) * 208 / rect.height);
    draw(cell.row, cell.column);
  }
});
canvas.addEventListener('pointerup', () => finishDrag());
canvas.addEventListener('pointercancel', () => finishDrag(true));
canvas.addEventListener('lostpointercapture', () => finishDrag(true));
canvas.addEventListener('pointerenter', () => {
  pointerOver = true;
  if (settings.gaze && !settings.globalGaze && canGaze()) cancelTimer();
});
canvas.addEventListener('pointerleave', () => {
  pointerOver = false;
  // Crossing the canvas boundary must never interrupt a greeting or a global
  // gaze pose. Only a local hover gaze needs to return to its idle schedule.
  if (settings.gaze && !settings.globalGaze && !dragging && !sequence) neutral();
});
canvas.addEventListener('dblclick', () => { if (!paused()) void callAPI('showSettings'); });
canvas.addEventListener('keydown', event => {
  if (!paused() && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void callAPI('showSettings'); }
});
settingsButton.addEventListener('click', () => { if (!paused()) void callAPI('showSettings'); });
dockHandle.addEventListener('click', () => { if (dock) void callAPI('undock'); });
dockHandle.addEventListener('keydown', event => {
  if (dock && event.key === 'Enter') { event.preventDefault(); void callAPI('undock'); }
});
document.addEventListener('keydown', event => {
  if (dock && event.key === 'Escape' && !event.repeat) { event.preventDefault(); void callAPI('undock'); }
});
window.addEventListener('blur', () => finishDrag(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pointerOver = false; finishDrag(true); }
  neutral();
});
reducedMotion.addEventListener('change', neutral);
try {
  manifest = await (await fetch('../assets/manifest.json')).json();
  atlasImage = new Image(); atlasImage.src = '../assets/' + manifest.image; await atlasImage.decode();
  ready = true; draw();
  api?.onState(applyState); api?.onAction(action => play(ACTIONS[action])); api?.onGaze?.(globalGaze);
  if (api) applyState(await api.getState());
  // The first state may equal the calm defaults, so start the initial schedule
  // explicitly without rearming it on subsequent metadata-only state events.
  if (!sequence && timer === undefined) scheduleIdle();
} catch (error) {
  cancelTimer();
  errorNotice.hidden = Boolean(dock?.collapsed);
  console.error('Unable to load local pet assets or application state', error);
}
