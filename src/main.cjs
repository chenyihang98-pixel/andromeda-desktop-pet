'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, session, protocol, dialog } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const {
  createSettingsStore, validateSettingsPatch, petSize, clampPosition, defaultPosition,
} = require('./settings.cjs');

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

function isAlive(window) { return window && !window.isDestroyed(); }
function hasTray() { return tray !== null && !tray.isDestroyed(); }

function state() {
  return {
    settings: { ...preferences.settings },
    visible: Boolean(isAlive(petWindow) && petWindow.isVisible()),
    trayAvailable: hasTray(),
    persistenceError,
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
  const [x, y] = petWindow.getPosition();
  preferences.position = { x, y };
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
  const bounds = petWindow.getBounds();
  const position = clampPosition(bounds, bounds, screen.getAllDisplays(), screen.getPrimaryDisplay());
  if (bounds.x !== position.x || bounds.y !== position.y) petWindow.setPosition(position.x, position.y);
  rememberPosition(true);
}

function stopDrag() {
  if (!dragSession) return;
  clearTimeout(dragSession.expiry);
  dragSession = null;
  if (isAlive(petWindow)) clampPetPosition();
}

function restorePet() {
  if (!isAlive(petWindow)) return;
  clampPetPosition();
  if (petWindow.isMinimized()) petWindow.restore();
  petWindow.show();
  petWindow.focus();
  updateTrayMenu();
  publishState();
}

function hidePet() {
  if (!hasTray()) throw new Error('系统托盘不可用，已保留星璇窗口，避免隐藏后无法找回。');
  stopDrag();
  if (isAlive(petWindow)) petWindow.hide();
  updateTrayMenu();
  publishState();
  return state();
}

function quit() {
  quitting = true;
  stopDrag();
  rememberPosition(true);
  app.quit();
}

function applySettings(patch) {
  const clean = validateSettingsPatch(patch);
  stopDrag();
  preferences.settings = { ...preferences.settings, ...clean };
  if (isAlive(petWindow)) {
    const size = petSize(preferences.settings.scale);
    const old = petWindow.getBounds();
    // Keep the bottom-center fixed when scaling, then ensure it is on a monitor.
    const position = clampPosition({
      x: old.x + (old.width - size.width) / 2,
      y: old.y + old.height - size.height,
    }, size, screen.getAllDisplays(), screen.getPrimaryDisplay());
    petWindow.setBounds({ ...position, ...size });
    petWindow.setAlwaysOnTop(preferences.settings.alwaysOnTop);
    preferences.position = position;
  }
  savePreferences();
  updateTrayMenu();
  publishState();
  return state();
}

function resetPosition() {
  stopDrag();
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
    { type: 'separator' },
    { label: '打个招呼', click: () => runAction('wave') },
    { label: '开心一下', click: () => runAction('jump') },
    { label: '安静陪伴', click: () => runAction('wait') },
    { label: '专注片刻', click: () => runAction('review') },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: preferences.settings.alwaysOnTop,
      click: (item) => applySettings({ alwaysOnTop: item.checked }) },
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

function registerIPC() {
  function handle(channel, callback, acceptsPatch = false) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trustedSender(event)) throw new Error('不允许此窗口执行操作');
      if (args.length !== (acceptsPatch ? 1 : 0)) throw new TypeError('无效的操作参数');
      return callback(...args);
    });
  }
  handle('andromeda:get-state', state);
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
    if (!petWindow.isVisible()) return;
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    if (cursor.x < bounds.x || cursor.y < bounds.y || cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height) return;
    dragSession = { cursor, origin: { x: bounds.x, y: bounds.y }, lastUpdate: 0, expiry: setTimeout(stopDrag, 30_000) };
  });
  dragHandler('andromeda:drag', () => {
    if (!dragSession || !petWindow.isVisible()) return;
    clearTimeout(dragSession.expiry);
    dragSession.expiry = setTimeout(stopDrag, 30_000);
    if (Date.now() - dragSession.lastUpdate < 15) return;
    dragSession.lastUpdate = Date.now();
    // No screen coordinates received from the renderer are trusted or accepted.
    const cursor = screen.getCursorScreenPoint();
    petWindow.setPosition(
      Math.round(dragSession.origin.x + cursor.x - dragSession.cursor.x),
      Math.round(dragSession.origin.y + cursor.y - dragSession.cursor.y),
    );
  });
  dragHandler('andromeda:end-drag', stopDrag);
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
  petWindow.webContents.on('context-menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: petWindow }));
  petWindow.once('ready-to-show', () => {
    if (quitting || !isAlive(petWindow)) return;
    petWindow.show(); // Hidden state is deliberately never persisted.
    publishState();
  });
  petWindow.on('move', () => rememberPosition());
  petWindow.on('blur', stopDrag);
  petWindow.on('hide', () => { stopDrag(); publishState(); });
  petWindow.on('show', publishState);
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
  stopDrag();
  if (isAlive(settingsWindow)) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  settingsWindow = new BrowserWindow({
    width: Math.min(480, area.width), height: Math.min(740, area.height),
    title: `${APP_NAME} · 设置`, icon: ICON_PATH,
    backgroundColor: '#10172b',
    resizable: false, maximizable: false, fullscreenable: false,
    show: false,
    webPreferences: webPreferences(),
  });
  secureWindow(settingsWindow);
  settingsWindow.once('ready-to-show', () => { if (isAlive(settingsWindow)) settingsWindow.show(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
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
    rememberPosition(true);
  });
  app.on('will-quit', () => { if (hasTray()) tray.destroy(); });
  app.on('window-all-closed', () => { if (!hasTray() || quitting) app.quit(); });
  app.whenReady().then(() => {
    if (profileError) throw profileError;
    if (process.platform === 'win32') app.setAppUserModelId('com.andromeda.desktop-pet');
    store = createSettingsStore(app.getPath('userData'));
    preferences = store.load();
    secureSession(session.defaultSession);
    desktopSession = session.fromPartition('andromeda-desktop', { cache: false });
    secureSession(desktopSession);
    installLocalProtocol(desktopSession);
    registerIPC();
    Menu.setApplicationMenu(null);
    createPetWindow();
    createTray();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(eventName, () => { stopDrag(); clampPetPosition(); });
    }
  }).catch((error) => {
    console.error('Unable to start Andromeda:', error);
    dialog.showErrorBox(APP_NAME, '启动失败。请检查应用文件完整性以及用户配置文件夹权限。');
    quitting = true;
    app.quit();
  });
}
