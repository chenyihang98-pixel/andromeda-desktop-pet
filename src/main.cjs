'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, session, protocol, dialog, powerMonitor, shell } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const {
  createSettingsStore, validateSettingsPatch, petSize, clampPosition, defaultPosition,
} = require('./settings.cjs');
const { dockAt, dockBounds, hitTest, HIDE_DELAY } = require('./docking.cjs');
const { applyDockWindowBounds } = require('./dock-window.cjs');

const RELEASES_URL = 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases';
const VERSION = require('../package.json').version;
const APP_NAME = '星璇（Andromeda）桌宠';
const ROOT = path.resolve(__dirname, '..');
const PET_URL = 'andromeda://app/src/pet.html';
const SETTINGS_URL = 'andromeda://app/src/settings.html';
const ICON_PATH = path.join(ROOT, 'assets', 'icon.png');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'; worker-src 'none'";
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
});

// The renderers need no network, credentials, filesystem access, or Node APIs.
app.setName(APP_NAME);
// Keep a predictable ASCII profile folder across development/portable builds,
// independently of the translated window title and electron-builder metadata.
let profileError = null;
try {
  const profileDirectory = path.join(app.getPath('appData'), 'Andromeda');
  mkdirSync(profileDirectory, { recursive: true });
  app.setPath('userData', profileDirectory);
} catch (error) { profileError = error; }
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
protocol.registerSchemesAsPrivileged([{
  scheme: 'andromeda',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

let petWindow = null;
let settingsWindow = null;
let tray = null;
let quitting = false;
let store;
let preferences;
let persistenceError = null;
let dragSession = null;
let positionSaveTimer = null;
let desktopSession;
let dock = null;
let desktopTimer = null;
let userHidden = false;
let contextMenuOpen = false;
let clickThroughActive = false;
let settingsBeforePause = false;
const pauses = new Set();

function paused() { return pauses.size > 0; }
function normalBounds() {
  if (!isAlive(petWindow)) return null;
  if (dock) {
    const layout = dockBounds(dock, petSize(preferences.settings.scale), screen.getAllDisplays());
    if (layout) return layout.expanded;
    return { ...preferences.position, ...petSize(preferences.settings.scale) };
  }
  return petWindow.getBounds();
}

function applyClickThrough() {
  if (!isAlive(petWindow)) return;
  const enabled = Boolean(preferences.settings.clickThrough && hasTray() && !dock && !dragSession && !paused());
  try {
    petWindow.setIgnoreMouseEvents(enabled);
    petWindow.setFocusable(!enabled);
    clickThroughActive = enabled;
  } catch {
    // Fail open: never leave an unresponsive pet after an unsupported OS call.
    try { petWindow.setIgnoreMouseEvents(false); petWindow.setFocusable(true); } catch { /* OS unavailable. */ }
    clickThroughActive = false;
    preferences.settings.clickThrough = false;
  }
}

function updateDesktopTimer() {
  const needed = !quitting && !paused() && isAlive(petWindow) && petWindow.isVisible()
    && Boolean(dock || preferences.settings.globalGaze || clickThroughActive);
  if (needed && !desktopTimer) desktopTimer = setInterval(pollDesktop, 100);
  if (!needed && desktopTimer) { clearInterval(desktopTimer); desktopTimer = null; }
}

function setDockCollapsed(collapsed) {
  if (!dock || !isAlive(petWindow)) return;
  dock.collapsed = collapsed;
  dock.hideAt = null;
  // Collapse the real input window instead of moving a full-size invisible
  // rectangle onto an adjacent monitor. Both geometries remain inside workArea.
  if (!applyDockWindowBounds(petWindow, dock, petSize(preferences.settings.scale), screen.getAllDisplays())) {
    undockPet(); return;
  }
  rememberPosition(true);
  applyClickThrough();
  updateTrayMenu(); publishState();
}

function undockPet() {
  if (!isAlive(petWindow)) return state();
  const bounds = normalBounds();
  dock = null;
  petWindow.setBounds(bounds);
  clampPetPosition();
  applyClickThrough();
  updateDesktopTimer();
  updateTrayMenu(); publishState();
  return state();
}

function pollDesktop() {
  if (quitting || paused() || !isAlive(petWindow) || !petWindow.isVisible()) { updateDesktopTimer(); return; }
  // A destroyed tray must not leave a click-through window stranded.
  if (clickThroughActive && !hasTray()) {
    preferences.settings.clickThrough = false;
    petWindow.setSkipTaskbar(false);
    applyClickThrough(); savePreferences(); publishState();
  }
  let cursor;
  try { cursor = screen.getCursorScreenPoint(); } catch { return; }
  if (dock && !dragSession) {
    const over = hitTest(cursor, petWindow.getBounds());
    if (dock.collapsed) {
      if (!over) dock.waitForLeave = false;
      else if (!dock.waitForLeave) setDockCollapsed(false);
    } else if (over || contextMenuOpen || (isAlive(settingsWindow) && settingsWindow.isVisible())) {
      dock.hideAt = null;
    } else if (dock.hideAt === null) {
      dock.hideAt = Date.now() + HIDE_DELAY;
    } else if (Date.now() >= dock.hideAt) {
      setDockCollapsed(true);
      if (dock) dock.waitForLeave = false;
    }
  }
  if (preferences.settings.globalGaze && !dragSession && !dock?.collapsed) {
    const bounds = petWindow.getBounds();
    // Send only a bounded direction in sprite coordinates; nothing is stored.
    petWindow.webContents.send('andromeda:gaze', {
      x: Math.max(-4096, Math.min(4096, (cursor.x - bounds.x - bounds.width / 2) * 192 / bounds.width)),
      y: Math.max(-4096, Math.min(4096, (cursor.y - bounds.y - bounds.height / 2) * 208 / bounds.height)),
    });
  }
}

function pauseDesktop(reason) {
  if (quitting) return;
  const first = !paused();
  pauses.add(reason);
  stopDrag();
  if (dock) dock.hideAt = null;
  if (first) settingsBeforePause = Boolean(isAlive(settingsWindow));
  if (isAlive(settingsWindow)) settingsWindow.hide();
  if (isAlive(petWindow)) petWindow.hide();
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function resumeDesktop(reason) {
  if (quitting) return;
  pauses.delete(reason);
  if (paused()) return;
  clampPetPosition();
  if (!userHidden && isAlive(petWindow)) petWindow.showInactive();
  if (settingsBeforePause && isAlive(settingsWindow)) settingsWindow.showInactive();
  settingsBeforePause = false;
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function isAlive(window) { return window && !window.isDestroyed(); }
function hasTray() { return tray !== null && !tray.isDestroyed(); }

function state() {
  return {
    settings: { ...preferences.settings },
    visible: Boolean(isAlive(petWindow) && petWindow.isVisible()),
    trayAvailable: hasTray(),
    persistenceError,
    version: VERSION,
    dock: dock ? { edge: dock.edge, collapsed: dock.collapsed } : null,
    clickThroughActive,
  };
}

function publishState() {
  if (!preferences) return;
  const value = state();
  for (const window of [petWindow, settingsWindow]) {
    if (isAlive(window) && !window.webContents.isDestroyed()) window.webContents.send('andromeda:state', value);
  }
}

function savePreferences() {
  if (!store || !preferences) return;
  try {
    store.save(preferences);
    persistenceError = null;
  } catch (error) {
    persistenceError = '设置暂时无法保存；本次运行仍可继续使用。请检查用户配置文件夹是否可写。';
    console.error('Could not save preferences:', error.code || 'write failed');
  }
}

function rememberPosition(immediate = false) {
  if (!isAlive(petWindow)) return;
  const bounds = normalBounds();
  preferences.position = { x: bounds.x, y: bounds.y };
  clearTimeout(positionSaveTimer);
  if (immediate) {
    positionSaveTimer = null;
    savePreferences();
    publishState();
  } else {
    positionSaveTimer = setTimeout(() => {
      positionSaveTimer = null;
      savePreferences();
      publishState();
    }, 350);
  }
}

function clampPetPosition() {
  if (!isAlive(petWindow)) return;
  if (dock) {
    if (applyDockWindowBounds(petWindow, dock, petSize(preferences.settings.scale), screen.getAllDisplays())) {
      rememberPosition(true); return;
    }
    const position = preferences.position;
    dock = null;
    const size = petSize(preferences.settings.scale);
    petWindow.setBounds({ ...clampPosition(position, size, screen.getAllDisplays(), screen.getPrimaryDisplay()), ...size });
  } else {
    const bounds = petWindow.getBounds();
    // A dock may have shrunk to fit a tiny work area. Free windows must use
    // the configured scale again instead of retaining those temporary bounds.
    const size = petSize(preferences.settings.scale);
    const position = clampPosition(bounds, size, screen.getAllDisplays(), screen.getPrimaryDisplay());
    if (bounds.width !== size.width || bounds.height !== size.height) petWindow.setBounds({ ...position, ...size });
    else if (bounds.x !== position.x || bounds.y !== position.y) petWindow.setPosition(position.x, position.y);
  }
  rememberPosition(true);
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function stopDrag(shouldDock = false) {
  if (!dragSession) return;
  let moved = dragSession.moved;
  if (shouldDock && isAlive(petWindow) && !paused()) {
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dragSession.cursor.x, dy = cursor.y - dragSession.cursor.y;
    moved ||= Math.hypot(dx, dy) >= 5;
    if (moved) {
      dock = null;
      petWindow.setPosition(Math.round(dragSession.origin.x + dx), Math.round(dragSession.origin.y + dy));
    }
  }
  clearTimeout(dragSession.expiry);
  dragSession = null;
  if (!isAlive(petWindow)) return;
  if (shouldDock && moved && preferences.settings.edgeDock && !quitting && !paused()) {
    const anchor = dockAt(petWindow.getBounds(), screen.getAllDisplays(), screen.getCursorScreenPoint());
    if (anchor) {
      dock = { ...anchor, collapsed: false, hideAt: null, waitForLeave: false };
      setDockCollapsed(true);
      if (dock) dock.waitForLeave = hitTest(screen.getCursorScreenPoint(), petWindow.getBounds());
    }
  }
  clampPetPosition();
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function restorePet() {
  if (!isAlive(petWindow) || quitting) return;
  stopDrag();
  userHidden = false;
  // Tray, reset and second-instance are unconditional recovery routes.
  preferences.settings.clickThrough = false;
  undockPet();
  if (!paused()) {
    if (petWindow.isMinimized()) petWindow.restore();
    petWindow.show(); petWindow.focus();
  }
  savePreferences(); updateTrayMenu(); updateDesktopTimer(); publishState();
}

function hidePet() {
  if (!hasTray()) throw new Error('系统托盘不可用，已保留星璇窗口，避免隐藏后无法找回。');
  userHidden = true;
  stopDrag();
  if (isAlive(petWindow)) petWindow.hide();
  updateTrayMenu(); updateDesktopTimer(); publishState();
  return state();
}

function quit() {
  quitting = true;
  stopDrag();
  clearInterval(desktopTimer); desktopTimer = null;
  rememberPosition(true);
  app.quit();
}

function applySettings(patch) {
  const clean = validateSettingsPatch(patch);
  if (clean.clickThrough && !hasTray()) throw new Error('系统托盘不可用，无法安全开启点击穿透。');
  stopDrag();
  const old = normalBounds();
  preferences.settings = { ...preferences.settings, ...clean };
  if (dock && !preferences.settings.edgeDock) undockPet();
  if (isAlive(petWindow)) {
    const size = petSize(preferences.settings.scale);
    if (dock) {
      setDockCollapsed(dock.collapsed);
    } else {
      // Keep the bottom-center fixed when scaling, then ensure visibility.
      const position = clampPosition({
        x: old.x + (old.width - size.width) / 2,
        y: old.y + old.height - size.height,
      }, size, screen.getAllDisplays(), screen.getPrimaryDisplay());
      petWindow.setBounds({ ...position, ...size });
      preferences.position = position;
    }
    petWindow.setAlwaysOnTop(preferences.settings.alwaysOnTop);
  }
  applyClickThrough(); updateDesktopTimer();
  savePreferences(); updateTrayMenu(); publishState();
  return state();
}

function resetPosition() {
  stopDrag();
  undockPet();
  if (isAlive(petWindow)) {
    const position = defaultPosition(petSize(preferences.settings.scale), screen.getPrimaryDisplay());
    petWindow.setPosition(position.x, position.y);
    rememberPosition(true);
    restorePet();
  }
  return state();
}

function runAction(action) {
  if (!['wave', 'jump', 'wait', 'review'].includes(action)) return;
  restorePet();
  if (isAlive(petWindow)) petWindow.webContents.send('andromeda:action', action);
}

function menuTemplate() {
  return [
    { label: APP_NAME, enabled: false },
    { label: '一款开发中的桌宠', enabled: false },
    { type: 'separator' },
    { label: '显示星璇', click: restorePet },
    { label: '暂时隐藏', enabled: hasTray(), click: () => hidePet() },
    { label: '设置…', click: showSettings },
    { label: '检查新版本（打开发布页）', click: () => { openReleases().catch(() => {}); } },
    { type: 'separator' },
    { label: '打个招呼', click: () => runAction('wave') },
    { label: '开心一下', click: () => runAction('jump') },
    { label: '安静陪伴', click: () => runAction('wait') },
    { label: '专注片刻', click: () => runAction('review') },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: preferences.settings.alwaysOnTop,
      click: (item) => applySettings({ alwaysOnTop: item.checked }) },
    { label: '边缘收纳', type: 'checkbox', checked: preferences.settings.edgeDock,
      click: (item) => applySettings({ edgeDock: item.checked }) },
    { label: '点击穿透（点托盘恢复）', type: 'checkbox', checked: preferences.settings.clickThrough, enabled: hasTray(),
      click: (item) => applySettings({ clickThrough: item.checked }) },
    { label: '移出边缘收纳', enabled: Boolean(dock), click: restorePet },
    { label: '重置位置', click: resetPosition },
    { type: 'separator' },
    { label: '退出星璇', click: quit },
  ];
}

function updateTrayMenu() {
  if (hasTray()) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  try {
    let icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'andromeda.png'));
    if (icon.isEmpty()) throw new Error('No tray icon');
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.setToolTip(APP_NAME);
    tray.on('click', restorePet);
    tray.on('double-click', restorePet);
    updateTrayMenu();
  } catch (error) {
    console.error('Tray unavailable:', error.message);
    if (hasTray()) tray.destroy();
    tray = null;
  }
  if (isAlive(petWindow)) petWindow.setSkipTaskbar(hasTray());
  publishState();
}

function trustedSender(event, petOnly = false) {
  const candidates = petOnly ? [[petWindow, PET_URL]] : [[petWindow, PET_URL], [settingsWindow, SETTINGS_URL]];
  return candidates.some(([window, expectedURL]) => (
    isAlive(window) && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === expectedURL
  ));
}

function openReleases() {
  // No renderer-supplied URL, fetch, downloaded code or auto-install path.
  return shell.openExternal(RELEASES_URL).then(() => true);
}

function registerIPC() {
  function handle(channel, callback, acceptsPatch = false) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trustedSender(event)) throw new Error('不允许此窗口执行操作');
      if (args.length !== (acceptsPatch ? 1 : 0)) throw new TypeError('无效的操作参数');
      return callback(...args);
    });
  }
  handle('andromeda:get-state', state);
  handle('andromeda:undock', () => { restorePet(); return state(); });
  handle('andromeda:open-releases', openReleases);
  handle('andromeda:set-settings', applySettings, true);
  handle('andromeda:show-settings', () => { showSettings(); return state(); });
  handle('andromeda:hide', hidePet);
  handle('andromeda:quit', () => { setImmediate(quit); return true; });
  handle('andromeda:reset-position', resetPosition);
  handle('andromeda:play-action', (action) => {
    if (typeof action !== 'string' || !['wave', 'jump', 'wait', 'review'].includes(action)) throw new TypeError('无效的动作');
    runAction(action);
    return state();
  }, true);

  function dragHandler(channel, callback) {
    ipcMain.on(channel, (event, ...args) => {
      if (!trustedSender(event, true) || args.length !== 0) return;
      callback();
    });
  }
  dragHandler('andromeda:start-drag', () => {
    if (!petWindow.isVisible() || paused() || contextMenuOpen || dock?.collapsed || clickThroughActive) return;
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    if (!hitTest(cursor, bounds)) return;
    if (dock) dock.hideAt = null;
    dragSession = { cursor, origin: { x: bounds.x, y: bounds.y }, moved: false, lastUpdate: 0, expiry: setTimeout(stopDrag, 30_000) };
  });
  dragHandler('andromeda:drag', () => {
    if (!dragSession || !petWindow.isVisible() || paused()) return;
    clearTimeout(dragSession.expiry);
    dragSession.expiry = setTimeout(stopDrag, 30_000);
    if (Date.now() - dragSession.lastUpdate < 15) return;
    dragSession.lastUpdate = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dragSession.cursor.x, dy = cursor.y - dragSession.cursor.y;
    if (!dragSession.moved && Math.hypot(dx, dy) < 5) return;
    dragSession.moved = true;
    if (dock) { dock = null; publishState(); }
    petWindow.setPosition(Math.round(dragSession.origin.x + dx), Math.round(dragSession.origin.y + dy));
  });
  dragHandler('andromeda:end-drag', () => stopDrag(true));
  dragHandler('andromeda:cancel-drag', () => stopDrag(false));
}

function isLocalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'andromeda:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function secureSession(target) {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.on('will-download', (event) => event.preventDefault());
  target.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isLocalURL(details.url) }));
}

function installLocalProtocol(target) {
  target.protocol.handle('andromeda', async (request) => {
    if (!isLocalURL(request.url) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part === '..' || part === '.')
      || !/^\/(src|assets)\//.test(pathname)) return new Response(null, { status: 403 });
    const filename = path.resolve(ROOT, `.${pathname}`);
    const relative = path.relative(ROOT, filename);
    const extension = path.extname(filename).toLowerCase();
    if (relative.startsWith('..') || path.isAbsolute(relative) || !MIME_TYPES[extension]) return new Response(null, { status: 403 });
    if (extension === '.html' && !['/src/pet.html', '/src/settings.html'].includes(pathname)) return new Response(null, { status: 403 });
    try {
      const real = await fs.realpath(filename);
      const realRelative = path.relative(ROOT, real);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)
        || !['src', 'assets'].includes(realRelative.split(path.sep)[0])
        || path.extname(real).toLowerCase() !== extension) return new Response(null, { status: 403 });
      const body = await fs.readFile(real);
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Content-Type': MIME_TYPES[extension],
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch { return new Response(null, { status: 404 }); }
  });
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    session: desktopSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: !app.isPackaged,
    navigateOnDragDrop: false,
    autoplayPolicy: 'document-user-activation-required',
  };
}

function secureWindow(window) {
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    window.webContents.on(eventName, (event) => event.preventDefault());
  }
  window.webContents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
  window.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  window.webContents.on('did-finish-load', publishState);
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  window.webContents.on('zoom-changed', () => window.webContents.setZoomFactor(1));
}

function loadWindow(window, url) {
  window.loadURL(url).catch(() => {
    if (quitting || !isAlive(window)) return;
    dialog.showErrorBox(APP_NAME, '界面文件无法加载。请重新解压完整安装包后再试。');
    quit();
  });
}

function createPetWindow() {
  const size = petSize(preferences.settings.scale);
  const position = clampPosition(preferences.position, size, screen.getAllDisplays(), screen.getPrimaryDisplay());
  petWindow = new BrowserWindow({
    ...size, ...position,
    title: APP_NAME,
    icon: ICON_PATH,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: preferences.settings.alwaysOnTop,
    skipTaskbar: false,
    show: false,
    webPreferences: webPreferences(),
  });
  secureWindow(petWindow);
  petWindow.webContents.on('context-menu', () => {
    contextMenuOpen = true;
    // Native menus can open without a window blur. Cancel before a queued
    // pointer release can turn the interrupted gesture into a dock.
    stopDrag(false);
    if (dock) dock.hideAt = null;
    Menu.buildFromTemplate(menuTemplate()).popup({ window: petWindow, callback: () => { contextMenuOpen = false; if (dock) dock.hideAt = null; } });
  });
  petWindow.once('ready-to-show', () => {
    if (quitting || !isAlive(petWindow)) return;
    if (!paused() && !userHidden) petWindow.show(); // Hidden/docked/clickthrough state does not strand a restart.
    applyClickThrough(); updateDesktopTimer(); publishState();
  });
  petWindow.on('move', () => rememberPosition());
  petWindow.on('blur', () => stopDrag(false));
  petWindow.on('hide', () => { stopDrag(); updateDesktopTimer(); publishState(); });
  petWindow.on('show', () => { updateDesktopTimer(); publishState(); });
  petWindow.on('close', (event) => {
    if (!quitting && hasTray()) {
      event.preventDefault();
      hidePet();
    } else if (!quitting) {
      // Without a tray, closing must not leave an invisible background process.
      quitting = true;
      rememberPosition(true);
      app.quit();
    }
  });
  petWindow.on('closed', () => { petWindow = null; });
  petWindow.webContents.on('render-process-gone', () => {
    if (quitting) return;
    dialog.showErrorBox(APP_NAME, '星璇的界面意外停止。请重新打开应用；已保存的设置会保留。');
    quit();
  });
  loadWindow(petWindow, PET_URL);
}

function showSettings() {
  if (quitting || paused()) return;
  stopDrag();
  if (dock) { dock.hideAt = null; if (dock.collapsed) setDockCollapsed(false); }
  if (isAlive(settingsWindow)) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  settingsWindow = new BrowserWindow({
    width: Math.min(480, area.width), height: Math.min(870, area.height),
    title: `${APP_NAME} · 设置`, icon: ICON_PATH,
    backgroundColor: '#10172b',
    resizable: false, maximizable: false, fullscreenable: false,
    show: false,
    webPreferences: webPreferences(),
  });
  secureWindow(settingsWindow);
  settingsWindow.once('ready-to-show', () => { if (!quitting && !paused() && isAlive(settingsWindow)) settingsWindow.show(); });
  settingsWindow.on('closed', () => { settingsWindow = null; if (dock) dock.hideAt = null; });
  loadWindow(settingsWindow, SETTINGS_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', restorePet);
  app.on('activate', restorePet);
  app.on('before-quit', () => {
    quitting = true;
    stopDrag();
    clearTimeout(positionSaveTimer);
    clearInterval(desktopTimer); desktopTimer = null;
    rememberPosition(true);
  });
  app.on('will-quit', () => { if (hasTray()) tray.destroy(); });
  app.on('window-all-closed', () => { if (!hasTray() || quitting) app.quit(); });
  app.whenReady().then(() => {
    if (profileError) throw profileError;
    if (process.platform === 'win32') app.setAppUserModelId('com.andromeda.desktop-pet');
    store = createSettingsStore(app.getPath('userData'));
    preferences = store.load();
    // Intentionally never start in click-through mode, even if enabled last run.
    preferences.settings.clickThrough = false;
    powerMonitor.on('lock-screen', () => pauseDesktop('locked'));
    powerMonitor.on('unlock-screen', () => resumeDesktop('locked'));
    powerMonitor.on('suspend', () => pauseDesktop('suspended'));
    powerMonitor.on('resume', () => resumeDesktop('suspended'));
    secureSession(session.defaultSession);
    desktopSession = session.fromPartition('andromeda-desktop', { cache: false });
    secureSession(desktopSession);
    installLocalProtocol(desktopSession);
    registerIPC();
    Menu.setApplicationMenu(null);
    createPetWindow();
    createTray();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(eventName, () => { stopDrag(); if (dock) dock.hideAt = null; clampPetPosition(); });
    }
  }).catch((error) => {
    console.error('Unable to start Andromeda:', error);
    dialog.showErrorBox(APP_NAME, '启动失败。请检查应用文件完整性以及用户配置文件夹权限。');
    quitting = true;
    app.quit();
  });
}
