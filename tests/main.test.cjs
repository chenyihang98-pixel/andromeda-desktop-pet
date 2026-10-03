'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SETTINGS } = require('../src/settings.cjs');
const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

// These tests exercise the actual main entry point against a small Electron
// adapter. They validate lifecycle/IPC policy without claiming native OS QA.
async function createShell(t, { trayWorks = true, lockAvailable = true } = {}) {
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-shell-'));
  const windows = [];
  const menus = [];
  const handlers = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, quitCount: 0, commandLine: { appendSwitch() {} },
    paths: {}, setName() {}, enableSandbox() {}, setAppUserModelId() {},
    setPath(name, value) { assert.equal(fs.statSync(value).isDirectory(), true); this.paths[name] = value; },
    requestSingleInstanceLock: () => lockAvailable,
    getPath(name) { return this.paths[name] || folder; },
    whenReady: () => Promise.resolve(),
    quit() { this.quitCount += 1; this.emit('before-quit'); this.emit('will-quit'); },
  });
  class FakeSession extends EventEmitter {
    constructor() {
      super();
      this.protocol = { handle: (_scheme, callback) => { this.localRequest = callback; } };
      this.webRequest = { onBeforeRequest: (callback) => { this.beforeRequest = callback; } };
    }
    setPermissionRequestHandler(value) { this.permissionRequest = value; }
    setPermissionCheckHandler(value) { this.permissionCheck = value; }
    setDevicePermissionHandler(value) { this.devicePermission = value; }
  }
  const defaultSession = new FakeSession();
  const desktopSession = new FakeSession();
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, sent: [],
        send(channel, value) { this.sent.push({ channel, value }); },
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler: (value) => { this.openHandler = value; },
        setVisualZoomLevelLimits: () => Promise.resolve(), setZoomFactor() {},
      });
      windows.push(this);
    }
    setMenu() {}
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    getBounds() { return { ...this.bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; this.emit('move'); }
    setBounds(value) { this.bounds = value; this.emit('move'); }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
      queueMicrotask(() => { this.webContents.emit('did-finish-load'); this.emit('ready-to-show'); });
      return Promise.resolve();
    }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) { this.destroyed = true; this.visible = false; this.emit('closed'); }
    }
  }
  class FakeTray extends EventEmitter {
    constructor() { super(); if (!trayWorks) throw new Error('simulated missing tray'); this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const image = { isEmpty: () => false, resize() { return this; } };
  const screen = new EventEmitter();
  Object.assign(screen, { cursor: { x: 1700, y: 800 }, getAllDisplays: () => [primary], getPrimaryDisplay: () => primary,
    getCursorScreenPoint() { return { ...this.cursor }; } });
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, callback) => handlers.set(channel, callback);
  const fakeElectron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray, screen, ipcMain,
    nativeImage: { createFromPath: () => image },
    Menu: { setApplicationMenu() {}, buildFromTemplate(items) { menus.push(items); return { items, popup() {} }; } },
    session: { defaultSession, fromPartition: () => desktopSession },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showErrorBox(_title, message) { throw new Error(message); } },
  };
  const entry = require.resolve('../src/main.cjs');
  const originalLoad = Module._load;
  try {
    Module._load = function (request, ...args) { return request === 'electron' ? fakeElectron : originalLoad.call(this, request, ...args); };
    delete require.cache[entry];
    require(entry);
  } finally { Module._load = originalLoad; }
  await new Promise((resolve) => setImmediate(resolve));
  t.after(() => {
    app.quit();
    delete require.cache[entry];
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const eventFor = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (window, channel, ...args) => handlers.get(`andromeda:${channel}`)(eventFor(window), ...args);
  return { app, windows, menus, handlers, eventFor, invoke, ipcMain, screen, desktopSession, folder: app.getPath('userData') };
}

test('shell isolates renderers, exposes only trusted IPC, and validates payloads', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  assert.equal(pet.options.transparent, true);
  assert.equal(pet.options.frame, false);
  assert.equal(pet.options.resizable, false);
  assert.equal(pet.options.webPreferences.sandbox, true);
  assert.equal(pet.options.webPreferences.contextIsolation, true);
  assert.equal(pet.options.webPreferences.nodeIntegration, false);
  assert.equal(pet.options.alwaysOnTop, true);
  assert.equal(pet.visible, true);
  assert.deepEqual(shell.invoke(pet, 'get-state').settings, DEFAULT_SETTINGS);
  assert.throws(() => shell.handlers.get('andromeda:get-state')({ sender: pet.webContents, senderFrame: { url: pet.webContents.mainFrame.url } }), /不允许/);
  assert.throws(() => shell.invoke(pet, 'get-state', 'extra'), /参数/);
  assert.throws(() => shell.invoke(pet, 'set-settings', { scale: 100 }), /缩放/);
  assert.throws(() => shell.invoke(pet, 'play-action', 'walk'), /动作/);
  shell.invoke(pet, 'set-settings', { scale: 2, alwaysOnTop: false });
  assert.equal(pet.bounds.width, 384);
  assert.equal(pet.alwaysOnTop, false);
  assert.equal(shell.invoke(pet, 'get-state').settings.scale, 2);
});

test('shell tray hide, second-instance restore, settings close, and explicit quit are distinct', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'hide');
  assert.equal(pet.visible, false);
  shell.app.emit('second-instance');
  assert.equal(pet.visible, true);
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  shell.windows[1].close();
  assert.equal(pet.visible, true);
  pet.close();
  assert.equal(pet.visible, false);
  assert.equal(pet.destroyed, false);
  shell.app.emit('second-instance');
  shell.invoke(pet, 'quit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(shell.app.quitCount > 0);
  const saved = JSON.parse(fs.readFileSync(path.join(shell.folder, 'settings.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'visible'), false);
});

test('shell without a tray refuses hiding, retains taskbar access, and exits on close', async (t) => {
  const shell = await createShell(t, { trayWorks: false });
  const pet = shell.windows[0];
  assert.equal(shell.invoke(pet, 'get-state').trayAvailable, false);
  assert.equal(pet.skipTaskbar, false);
  assert.throws(() => shell.invoke(pet, 'hide'), /托盘不可用/);
  assert.equal(pet.visible, true);
  pet.close();
  assert.ok(shell.app.quitCount > 0);
});

test('shell refuses network, permissions, downloads, popups, and page navigation', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  const target = shell.desktopSession;
  for (const url of ['https://example.com', 'http://example.com', 'wss://example.com', 'file:///etc/passwd', 'andromeda://other/src/pet.html']) {
    target.beforeRequest({ url }, (result) => assert.equal(result.cancel, true));
  }
  target.beforeRequest({ url: 'andromeda://app/assets/manifest.json' }, (result) => assert.equal(result.cancel, false));
  assert.equal(target.permissionCheck(), false);
  assert.equal(target.devicePermission(), false);
  target.permissionRequest(null, 'media', (allowed) => assert.equal(allowed, false));
  assert.deepEqual(pet.openHandler(), { action: 'deny' });
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false;
    pet.webContents.emit(name, { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  let downloadPrevented = false;
  target.emit('will-download', { preventDefault() { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true);
});

test('local protocol serves bundled modules with CSP and denies traversal/private code', async (t) => {
  const shell = await createShell(t);
  const request = (url, method = 'GET') => shell.desktopSession.localRequest({ url, method });
  const good = await request('andromeda://app/src/pet.html');
  assert.equal(good.status, 200);
  assert.match(good.headers.get('Content-Security-Policy'), /object-src 'none'/);
  assert.match(await good.text(), /<canvas/);
  const module = await request('andromeda://app/src/animation.mjs');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('Content-Type'), /javascript/);
  for (const url of [
    'andromeda://app/src/main.cjs', 'andromeda://app/package.json',
    'andromeda://app/src/..%2fpackage.json', 'andromeda://app/src/%2e%2e%2fpackage.json',
    'andromeda://app/src/%5c..%5cpackage.json', 'https://example.com/src/pet.html',
  ]) assert.equal((await request(url)).status, 403, url);
  assert.equal((await request('andromeda://app/src/pet.html', 'POST')).status, 403);
  assert.equal((await request('andromeda://app/src/missing.js')).status, 404);
});

test('dragging accepts only the pet sender and uses native cursor coordinates', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  const original = pet.getPosition();
  const event = shell.eventFor(pet);
  shell.screen.cursor = { x: original[0] + 10, y: original[1] + 10 };
  shell.ipcMain.emit('andromeda:start-drag', event, { x: -99999 });
  shell.screen.cursor.x += 20;
  shell.ipcMain.emit('andromeda:drag', event);
  assert.deepEqual(pet.getPosition(), original);
  shell.ipcMain.emit('andromeda:start-drag', event);
  shell.screen.cursor.x -= 100;
  shell.screen.cursor.y -= 100;
  shell.ipcMain.emit('andromeda:drag', event);
  assert.deepEqual(pet.getPosition(), [original[0] - 100, original[1] - 100]);
  shell.ipcMain.emit('andromeda:end-drag', event);
  const after = pet.getPosition();
  shell.screen.cursor.x -= 100;
  shell.ipcMain.emit('andromeda:drag', event);
  assert.deepEqual(pet.getPosition(), after);
});

test('a second process with no instance lock creates no windows', async (t) => {
  const shell = await createShell(t, { lockAvailable: false });
  assert.equal(shell.windows.length, 0);
  assert.equal(shell.app.quitCount, 1);
});
