const api = window.andromeda;
const status = document.querySelector('#status');
const toggleKeys = ['alwaysOnTop', 'gaze', 'edgeDock', 'globalGaze', 'clickThrough'];
let state, latestPatch = 0;
function showError(message = '这次操作未能完成，请再试一次') {
  status.textContent = message; status.classList.add('error');
}
function render(next) {
  if (!next?.settings) return;
  state = {...next, settings: {...next.settings}};
  document.querySelectorAll('[data-motion]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.motion === next.settings.motion)));
  document.querySelector('#scale').value = next.settings.scale;
  document.querySelector('#scale-value').textContent = Math.round(next.settings.scale * 100) + '%';
  for (const key of toggleKeys) document.querySelector('#' + key).checked = Boolean(next.settings[key]);
  document.querySelector('#version').textContent = 'ANDROMEDA · ' + (next.version || '0.2.0');
  document.querySelector('#hide').disabled = !next.trayAvailable;
  document.querySelector('#clickThrough').disabled = !next.trayAvailable;
  document.querySelector('#click-through-help').textContent = !next.trayAvailable
    ? '系统托盘不可用，鼠标穿透已禁用，避免无法找回角色窗口'
    : '穿透整个角色窗口。点击系统托盘图标可关闭穿透并解除停靠；停靠时自动暂停穿透';
  const desktop = document.querySelector('#desktop-state');
  desktop.textContent = next.clickThroughActive ? '鼠标穿透中 · 点击系统托盘图标恢复互动'
    : next.settings.clickThrough && next.dock ? '已停靠 · 鼠标穿透暂时停用'
    : next.dock?.collapsed ? '已收起为星标 · 悬停展开'
    : next.dock ? '已停靠 · 向内拖动或按 Esc 解除' : '';
  desktop.hidden = !desktop.textContent;
  status.textContent = next.persistenceError ? '设置暂时无法保存。当前会话仍可继续使用；退出前请检查磁盘空间与文件夹权限。' : next.trayAvailable ? '设置已自动保存 · 隐藏后可从系统托盘找回星璇' : '系统托盘不可用。隐藏和鼠标穿透已关闭，退出按钮仍可使用。';
  status.classList.toggle('error', Boolean(next.persistenceError));
}
async function patch(value) {
  const request = ++latestPatch;
  try {
    const updated = await api.setSettings(value);
    if (request === latestPatch && updated?.settings) render(updated);
  } catch {
    if (request !== latestPatch) return;
    if (state) render(state);
    showError('这次设置未能应用，请再试一次');
  }
}
async function invoke(method, ...args) {
  try {
    const updated = await api[method](...args);
    if (updated?.settings) render(updated);
    return true;
  } catch { showError(); return false; }
}
document.querySelectorAll('[data-motion]').forEach(button => button.addEventListener('click', () => { void patch({motion: button.dataset.motion}); }));
document.querySelector('#scale').addEventListener('input', event => { document.querySelector('#scale-value').textContent = Math.round(event.target.value * 100) + '%'; });
document.querySelector('#scale').addEventListener('change', event => { void patch({scale: Number(event.target.value)}); });
for (const key of toggleKeys) document.querySelector('#' + key).addEventListener('change', event => {
  if (key === 'clickThrough' && !state?.trayAvailable) { if (state) render(state); return; }
  void patch({[key]: event.target.checked});
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { void invoke('playAction', button.dataset.action); }));
for (const [id, method] of [['reset', 'resetPosition'], ['hide', 'hide'], ['quit', 'quit']]) {
  document.querySelector('#' + id).addEventListener('click', () => { void invoke(method); });
}
const releasesButton = document.querySelector('#releases');
releasesButton.addEventListener('click', async () => {
  if (releasesButton.disabled) return;
  releasesButton.disabled = true;
  try {
    if (await invoke('openReleases')) {
      status.textContent = '已在默认浏览器打开版本发布页，请对照当前版本 0.2.0 手动查看';
      status.classList.remove('error');
    }
  } finally { releasesButton.disabled = false; }
});
try { api.onState(render); render(await api.getState()); }
catch { showError('请从 Andromeda 应用打开设置面板'); }
