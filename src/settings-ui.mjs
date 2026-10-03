const api = window.andromeda;
const status = document.querySelector('#status');
let state;
function render(next) {
  state = next;
  document.querySelectorAll('[data-motion]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.motion === next.settings.motion)));
  document.querySelector('#scale').value = next.settings.scale;
  document.querySelector('#scale-value').textContent = Math.round(next.settings.scale * 100) + '%';
  for (const key of ['alwaysOnTop', 'gaze']) document.querySelector('#' + key).checked = next.settings[key];
  document.querySelector('#hide').disabled = !next.trayAvailable;
  status.textContent = next.persistenceError ? '设置暂时无法保存。当前会话仍可继续使用；退出前请检查磁盘空间与文件夹权限。' : next.trayAvailable ? '设置已自动保存 · 隐藏后可从系统托盘找回星璇' : '系统托盘不可用。隐藏功能已关闭，退出按钮仍可使用。';
  status.classList.toggle('error', Boolean(next.persistenceError));
}
async function patch(value) {
  try { const updated = await api.setSettings(value); if (updated?.settings) render(updated); }
  catch { status.textContent = '这次设置未能应用，请再试一次'; status.classList.add('error'); }
}
document.querySelectorAll('[data-motion]').forEach(button => button.addEventListener('click', () => patch({motion: button.dataset.motion})));
document.querySelector('#scale').addEventListener('input', event => { document.querySelector('#scale-value').textContent = Math.round(event.target.value * 100) + '%'; });
document.querySelector('#scale').addEventListener('change', event => patch({scale: Number(event.target.value)}));
for (const key of ['alwaysOnTop', 'gaze']) document.querySelector('#' + key).addEventListener('change', event => patch({[key]: event.target.checked}));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => api.playAction(button.dataset.action)));
document.querySelector('#reset').addEventListener('click', () => api.resetPosition());
document.querySelector('#hide').addEventListener('click', () => api.hide());
document.querySelector('#quit').addEventListener('click', () => api.quit());
try { api.onState(render); render(await api.getState()); }
catch { status.textContent = '请从 Andromeda 应用打开设置面板'; }
