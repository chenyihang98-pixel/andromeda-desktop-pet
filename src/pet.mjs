import {ACTIONS, frameAt, neutralDelay, gazeCell, cropRect} from './animation.mjs';
const api = window.andromeda;
const canvas = document.querySelector('#pet');
const context = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let manifest, atlasImage, settings = {motion: 'quiet', gaze: false};
let timer, sequence, dragging = false, pointerOver = false, ready = false;
function cancelTimer() { clearTimeout(timer); timer = undefined; }
function draw(row = 0, column = 0) {
  if (!ready) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(atlasImage, ...cropRect(manifest.atlas, row, column), 0, 0, canvas.width, canvas.height);
  canvas.dataset.row = String(row); canvas.dataset.column = String(column);
}
function scheduleIdle() {
  cancelTimer();
  if (document.hidden || dragging || (settings.gaze && pointerOver) || reducedMotion.matches) return;
  const delay = neutralDelay(settings.motion);
  if (delay !== null) timer = setTimeout(() => play('idle'), delay);
}
function neutral() { sequence = undefined; draw(); scheduleIdle(); }
function tick() {
  if (!sequence || document.hidden) return;
  const frame = frameAt(manifest.animations[sequence.state], performance.now() - sequence.start, sequence.multiplier);
  if (!frame) { neutral(); return; }
  draw(frame.row, frame.column);
  timer = setTimeout(tick, Math.max(4, frame.remainingMs));
}
function play(state) {
  if (!ready || dragging || !manifest.animations[state] || document.hidden) return;
  cancelTimer();
  if (reducedMotion.matches) { draw(manifest.animations[state].row, 0); timer = setTimeout(neutral, 900); return; }
  sequence = {state, start: performance.now(), multiplier: state === 'idle' ? manifest.desktopPlayback.idleSpeedMultiplier : 1.5};
  tick();
}
function applyState(state) { settings = state.settings; neutral(); }
function endDrag() {
  if (!dragging) return;
  dragging = false; canvas.classList.remove('dragging'); api?.endDrag(); neutral();
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragging = true; cancelTimer(); sequence = undefined; draw(); canvas.classList.add('dragging');
  canvas.setPointerCapture(event.pointerId); api?.startDrag();
});
canvas.addEventListener('pointermove', event => {
  if (dragging) { api?.drag(); return; }
  if (settings.gaze && ready && !sequence && !reducedMotion.matches) {
    const rect = canvas.getBoundingClientRect();
    const cell = gazeCell((event.clientX - rect.left - rect.width / 2) * 192 / rect.width, (event.clientY - rect.top - rect.height / 2) * 208 / rect.height);
    draw(cell.row, cell.column);
  }
});
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);
canvas.addEventListener('pointerenter', () => { pointerOver = true; if (settings.gaze && !sequence && !reducedMotion.matches) cancelTimer(); });
canvas.addEventListener('pointerleave', () => { pointerOver = false; if (!dragging) neutral(); });
canvas.addEventListener('dblclick', () => api?.showSettings());
canvas.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); api?.showSettings(); }
});
document.querySelector('#settings-button').addEventListener('click', () => api?.showSettings());
window.addEventListener('blur', endDrag);
document.addEventListener('visibilitychange', () => { cancelTimer(); if (!document.hidden) neutral(); });
reducedMotion.addEventListener('change', neutral);
try {
  manifest = await (await fetch('../assets/manifest.json')).json();
  atlasImage = new Image(); atlasImage.src = '../assets/' + manifest.image; await atlasImage.decode();
  ready = true; draw();
  api?.onState(applyState); api?.onAction(action => play(ACTIONS[action]));
  if (api) applyState(await api.getState()); else scheduleIdle();
} catch (error) {
  document.querySelector('#error').hidden = false;
  console.error('Unable to load local pet assets', error);
}
