'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SETTINGS, petSize } = require('../src/settings.cjs');
const primary = {
  id: 1, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

// These tests exercise the actual main entry point against a small Electron
// adapter. They validate lifecycle/IPC policy without claiming native OS QA.
async function createShell(t, {
  trayWorks = true, lockAvailable = true, displays = [primary],
  saved = null, deferReady = false, ignoreMouseFails = false, nativeMinimumSize = null,
  platform = 'win32', fullscreenHelperExists = true, packaged = false,
  screenToDipPoint = (point) => ({ ...point }),
} = {}) {
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-shell-'));
  const windows = [];
  const menus = [], trays = [], popups = [], externalURLs = [], fullscreenMonitors = [];
  let now = 1_000_000, serial = 0;
  const timers = new Map();
  const schedule = (fn, delay, interval = false) => {
    const id = ++serial;
    timers.set(id, { fn, due: now + delay, delay, interval }); return id;
  };
  const clock = {
    pending: () => timers.size,
    intervals: () => [...timers.values()].filter((timer) => timer.interval).length,
    advance(ms) {
      const end = now + ms; let iterations = 0;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        assert.ok(++iterations < 10_000, 'Main scheduled runaway timers');
        now = timer.due;
        if (timer.interval) timer.due += timer.delay; else timers.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
  const FakeDate = class extends Date { static now() { return now; } };
  if (saved) {
    fs.mkdirSync(path.join(folder, 'Andromeda'));
    fs.writeFileSync(path.join(folder, 'Andromeda', 'settings.json'), JSON.stringify(saved));
  }
  const handlers = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: packaged, quitCount: 0, commandLine: { appendSwitch() {} },
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
      super(); this.options = options; this.destroyed = false; this.visible = false; this.calls = [];
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
    setIgnoreMouseEvents(value) {
      this.calls.push(['ignoreMouse', value]);
      if (value && ignoreMouseFails) throw new Error('simulated unsupported clickthrough');
      this.ignoreMouse = value;
    }
    setFocusable(value) { this.focusable = value; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    focus() { this.calls.push(['focus']); }
    getBounds() { return { ...this.bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; this.emit('move'); }
    setBounds(value) {
      this.bounds = { ...value };
      if (nativeMinimumSize) {
        this.bounds.width = Math.max(value.width, nativeMinimumSize.width);
        this.bounds.height = Math.max(value.height, nativeMinimumSize.height);
      }
      this.emit('move');
    }
    show() { this.calls.push(['show']); this.visible = true; this.emit('show'); }
    showInactive() { this.calls.push(['showInactive']); this.show(); }
    hide() { this.visible = false; this.emit('hide'); }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
      if (!deferReady) queueMicrotask(() => this.ready());
      return Promise.resolve();
    }
    ready() { this.webContents.emit('did-finish-load'); this.emit('ready-to-show'); }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) { this.destroyed = true; this.visible = false; this.emit('closed'); }
    }
  }
  class FakeTray extends EventEmitter {
    constructor() { super(); if (!trayWorks) throw new Error('simulated missing tray'); this.destroyed = false; trays.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const image = { isEmpty: () => false, resize() { return this; } };
  const screen = new EventEmitter();
  Object.assign(screen, {
    cursor: { x: 1700, y: 800 }, displays, primary: displays[0], cursorReads: 0, physicalPoints: [],
    getAllDisplays() { return this.displays; }, getPrimaryDisplay() { return this.primary; },
    getCursorScreenPoint() { this.cursorReads += 1; return { ...this.cursor }; },
    screenToDipPoint(point) { this.physicalPoints.push({ ...point }); return screenToDipPoint(point); },
    getDisplayMatching(bounds) {
      const overlap = (display) => {
        const area = display.bounds || display.workArea;
        return Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
          * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
      };
      return [...this.displays].sort((a, b) => overlap(b) - overlap(a))[0];
    },
  });
  const powerMonitor = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, callback) => handlers.set(channel, callback);
  const fakeElectron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray, screen, ipcMain, powerMonitor,
    shell: { openExternal: async (url) => { externalURLs.push(url); } },
    nativeImage: { createFromPath: () => image },
    Menu: { setApplicationMenu() {}, buildFromTemplate(items) { menus.push(items); return { items, popup(options) { popups.push(options); } }; } },
    session: { defaultSession, fromPartition: () => desktopSession },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showErrorBox(_title, message) { throw new Error(message); } },
  };
  const entry = require.resolve('../src/main.cjs');
  // Scope the fake clock to the actual entry point, without replacing Node's
  // global timers or changing its implementation for the adapter.
  const localRequire = Module.createRequire(entry);
  const resourcesPath = path.join(folder, 'resources');
  const helperPath = packaged
    ? path.join(resourcesPath, 'native', 'windows-fullscreen.exe')
    : path.resolve(path.dirname(entry), '..', 'dist', 'native', 'windows-fullscreen.exe');
  const entryRequire = (name) => {
    if (name === 'electron') return fakeElectron;
    if (name === 'node:fs') return {
      ...fs, existsSync: (file) => file === helperPath ? fullscreenHelperExists : fs.existsSync(file),
    };
    if (name === './fullscreen-monitor.cjs') return {
      createFullscreenMonitor(options) {
        const monitor = {
          helperPath: options.helperPath, starts: 0, stops: 0,
          start() { this.starts += 1; }, stop() { this.stops += 1; },
          // Deliberately deliver even after stop to exercise late-child guards.
          snapshot: (value) => options.onChange(value), error: () => options.onError(),
        };
        fullscreenMonitors.push(monitor);
        return monitor;
      },
    };
    return localRequire(name);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'process',
    fs.readFileSync(entry, 'utf8'))(
    entryRequire, {exports: {}}, {}, entry, path.dirname(entry),
    (fn, delay) => schedule(fn, delay), (id) => timers.delete(id),
    (fn, delay) => schedule(fn, delay, true), (id) => timers.delete(id), FakeDate,
    { platform, resourcesPath },
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.after(() => {
    app.quit();
    delete require.cache[entry];
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const eventFor = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (window, channel, ...args) => handlers.get(`andromeda:${channel}`)(eventFor(window), ...args);
  return {
    app, windows, menus, trays, popups, handlers, eventFor, invoke, ipcMain,
    screen, powerMonitor, desktopSession, clock, externalURLs, folder: app.getPath('userData'),
    fullscreenMonitors, fullscreenHelperPath: helperPath,
    send: (channel, ...args) => ipcMain.emit(`andromeda:${channel}`, eventFor(windows[0]), ...args),
    state: () => invoke(windows[0], 'get-state'),
    saved: () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')),
  };
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
  assert.throws(() => shell.invoke(pet, 'set-settings', {clickThrough: true}), /托盘不可用/);
  assert.equal(pet.visible, true);
  pet.close();
  assert.ok(shell.app.quitCount > 0);
});

test('shell refuses network, permissions, downloads, popups, and page navigation', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  const target = shell.desktopSession;
  for (const url of ['https://example.com', 'http://example.com', 'wss://example.com', 'file:///etc/passwd', 'andromeda://other/src/pet.html', 'andromeda://user@app/src/pet.html', 'andromeda://app:443/src/pet.html', 'javascript:alert(1)']) {
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

function movePet(shell, x, y, finish = 'end-drag') {
  const pet = shell.windows[0], old = pet.getBounds();
  shell.screen.cursor = { x: old.x + 20, y: old.y + 20 };
  shell.send('start-drag');
  shell.clock.advance(20);
  shell.screen.cursor = { x: x + 20, y: y + 20 };
  shell.send('drag');
  if (finish) shell.send(finish);
}

function leaveHandle(shell) {
  shell.screen.cursor = { x: 960, y: 500 };
  shell.clock.advance(100);
}

function revealHandle(shell) {
  leaveHandle(shell);
  const bounds = shell.windows[0].getBounds();
  shell.screen.cursor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  shell.clock.advance(100);
  assert.equal(shell.state().dock.collapsed, false);
}

function within(bounds, area) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}

test('dock collapses only on deliberate release at any of the four work-area edges', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  const { width, height } = petSize(DEFAULT_SETTINGS.scale);
  for (const [edge, x, y] of [
    ['left', 18, 300], ['right', 1920 - width - 18, 300],
    ['top', 700, 18], ['bottom', 700, 1040 - height - 18],
  ]) {
    shell.invoke(pet, 'reset-position');
    movePet(shell, x, y, null);
    assert.equal(shell.state().dock, null, `Does not dock during ${edge} drag`);
    assert.deepEqual(pet.getBounds(), { x, y, width, height });
    shell.send('end-drag');
    assert.deepEqual(shell.state().dock, {edge, collapsed: true});
    assert.deepEqual([pet.bounds.width, pet.bounds.height], ['left', 'right'].includes(edge) ? [14, 64] : [64, 14]);
    within(pet.getBounds(), primary.workArea);
    assert.equal(shell.windows.length, 1, 'The handle reuses the single pet window');
    revealHandle(shell);
    assert.deepEqual([pet.bounds.width, pet.bounds.height], [width, height]);
    within(pet.getBounds(), primary.workArea);
  }
});

test('dock threshold, disabled option, no-motion clicks, and cancellation do not accidentally dock', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  movePet(shell, 19, 300);
  assert.equal(shell.state().dock, null, '19 DIP is outside the 18 DIP threshold');
  for (const finish of ['cancel-drag', 'blur', 'expiry']) {
    shell.invoke(pet, 'reset-position');
    movePet(shell, 0, 300, null);
    if (finish === 'blur') pet.emit('blur');
    else if (finish === 'expiry') shell.clock.advance(30_001);
    else shell.send(finish);
    assert.equal(shell.state().dock, null, finish);
    const position = pet.getPosition();
    shell.screen.cursor.x += 500;
    shell.send('drag'); shell.send('end-drag');
    assert.deepEqual(pet.getPosition(), position, finish);
  }
  pet.setPosition(0, 300);
  shell.screen.cursor = {x: 20, y: 320};
  shell.send('start-drag'); shell.send('end-drag');
  assert.equal(shell.state().dock, null, 'A stationary click is not a dock gesture');
  shell.invoke(pet, 'set-settings', {edgeDock: false});
  movePet(shell, 0, 400);
  assert.equal(shell.state().dock, null, 'Disabled edge docking stays disabled');
});

test('drag IPC rejects outside starts, settings windows, spoofed frames, and extra payloads', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  const b = pet.getBounds();
  for (const cursor of [
    {x: b.x - 1, y: b.y}, {x: b.x, y: b.y - 1},
    {x: b.x + b.width, y: b.y}, {x: b.x, y: b.y + b.height},
  ]) {
    shell.screen.cursor = cursor; shell.send('start-drag');
    shell.screen.cursor = {x: 0, y: 0}; shell.send('drag'); shell.send('end-drag');
    assert.deepEqual(pet.getBounds(), b);
  }
  for (const event of [
    shell.eventFor(shell.windows[1]),
    {sender: pet.webContents, senderFrame: {url: pet.webContents.mainFrame.url}},
    {sender: {}, senderFrame: pet.webContents.mainFrame},
  ]) {
    shell.screen.cursor = {x: b.x + 20, y: b.y + 20};
    shell.ipcMain.emit('andromeda:start-drag', event);
    shell.screen.cursor = {x: 0, y: 0}; shell.send('drag'); shell.send('end-drag');
    assert.deepEqual(pet.getBounds(), b);
  }
  shell.screen.cursor = {x: b.x + 20, y: b.y + 20}; shell.send('start-drag');
  shell.screen.cursor = {x: b.x - 50, y: b.y - 50};
  shell.send('drag', {x: 0, y: 0});
  assert.deepEqual(pet.getBounds(), b, 'Coordinate payloads are rejected');
  shell.send('cancel-drag');
  shell.invoke(pet, 'hide'); shell.send('start-drag'); shell.send('drag');
  assert.deepEqual(pet.getBounds(), b, 'Invisible pets cannot be dragged');
});

test('docked hover reveals, leaves wait 700ms, and re-enter cancels the pending collapse', async (t) => {
  const shell = await createShell(t);
  movePet(shell, 0, 300);
  revealHandle(shell);
  leaveHandle(shell); // First outside sample arms the 700ms deadline.
  shell.clock.advance(600);
  assert.equal(shell.state().dock.collapsed, false);
  shell.clock.advance(100);
  assert.equal(shell.state().dock.collapsed, true);
  revealHandle(shell);
  leaveHandle(shell);
  shell.clock.advance(600);
  const pet = shell.windows[0];
  shell.screen.cursor = {x: pet.bounds.x + 20, y: pet.bounds.y + 20};
  shell.clock.advance(100);
  assert.equal(shell.state().dock.collapsed, false, 'Re-entry cancels rather than running an old deadline');
  shell.clock.advance(1000);
  assert.equal(shell.state().dock.collapsed, false);
});

test('expanded dock keeps its anchor on click or small jitter, and actual dragging undocks', async (t) => {
  const shell = await createShell(t);
  movePet(shell, 0, 300); revealHandle(shell);
  const pet = shell.windows[0], b = pet.getBounds();
  shell.screen.cursor = {x: b.x + 20, y: b.y + 20}; shell.send('start-drag');
  shell.screen.cursor.x += 4; shell.clock.advance(20); shell.send('drag'); shell.send('end-drag');
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: false});
  assert.deepEqual(pet.getBounds(), b);
  shell.screen.cursor = {x: b.x + 20, y: b.y + 20}; shell.send('start-drag');
  shell.screen.cursor.x += 6; shell.clock.advance(20); shell.send('drag');
  assert.equal(shell.state().dock, null, 'Movement, not pointerdown, undocks');
  shell.send('cancel-drag');
  assert.deepEqual(pet.getPosition(), [b.x + 6, b.y]);
});

test('release samples the final native cursor after a throttled move', async (t) => {
  const shell = await createShell(t);
  movePet(shell, 500, 300, null);
  shell.screen.cursor = {x: 20, y: 320};
  shell.send('drag'); // Same timestamp: throttled in main.
  shell.send('end-drag');
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: true});
  assert.deepEqual(shell.saved().position, {x: 0, y: 300});
});

test('settings and an open native context menu prevent auto-collapse until closed', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  movePet(shell, 0, 300); revealHandle(shell); leaveHandle(shell);
  pet.webContents.emit('context-menu');
  shell.clock.advance(2000);
  assert.equal(shell.state().dock.collapsed, false);
  shell.popups.at(-1).callback();
  shell.clock.advance(100 + 700);
  assert.equal(shell.state().dock.collapsed, true);
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shell.state().dock.collapsed, false);
  shell.clock.advance(2000);
  assert.equal(shell.state().dock.collapsed, false);
  shell.windows[1].close();
  shell.clock.advance(100 + 700);
  assert.equal(shell.state().dock.collapsed, true);
});

test('a native context menu cancels dragging without relying on blur or pointer cancellation', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  movePet(shell, 0, 300, null);
  pet.webContents.emit('context-menu');
  const bounds = pet.getBounds();
  shell.send('end-drag');
  assert.equal(shell.state().dock, null, 'An interrupted release must not dock');
  assert.deepEqual(pet.getBounds(), bounds);

  shell.send('start-drag');
  shell.screen.cursor = {x: 320, y: 420};
  shell.clock.advance(20); shell.send('drag'); shell.send('end-drag');
  assert.deepEqual(pet.getBounds(), bounds, 'An open menu must reject queued drag starts');
  assert.equal(shell.state().dock, null);
  assert.equal(shell.clock.pending(), 0, 'Menu cancellation clears the drag expiry');

  shell.popups.at(-1).callback();
  movePet(shell, 0, 400);
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: true}, 'Dragging works again after closing the menu');
});

test('collapsed storage, scaling, reset, undock, and tray recovery keep normal pet bounds', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  movePet(shell, 0, 300);
  assert.deepEqual(shell.saved().position, {x: 0, y: 300}, 'Persist the full-pet anchor, not the handle origin');
  assert.deepEqual(Object.keys(shell.saved()).sort(), ['position', 'settings', 'version']);
  shell.invoke(pet, 'set-settings', {scale: 2});
  assert.equal(pet.bounds.width, 14);
  shell.invoke(pet, 'undock');
  assert.equal(shell.state().dock, null);
  assert.deepEqual([pet.bounds.width, pet.bounds.height], [384, 416]);
  within(pet.getBounds(), primary.workArea);
  movePet(shell, 0, 300);
  shell.invoke(pet, 'set-settings', {edgeDock: false});
  assert.equal(shell.state().dock, null);
  assert.equal(pet.bounds.width, 384);
  shell.invoke(pet, 'set-settings', {edgeDock: true});
  movePet(shell, 0, 400); shell.trays[0].emit('click');
  assert.equal(shell.state().dock, null);
  assert.equal(pet.bounds.width, 384);
  movePet(shell, 0, 300); shell.invoke(pet, 'reset-position');
  assert.equal(shell.state().dock, null);
  assert.deepEqual(pet.getBounds(), {x: 1512, y: 600, width: 384, height: 416});
});

test('display removal, taskbar changes, and mixed DPI preserve visible DIP geometry', async (t) => {
  const left = {id: 2, scaleFactor: 2, workArea: {x: -1280, y: -100, width: 1280, height: 984}};
  const shell = await createShell(t, {displays: [primary, left]});
  const pet = shell.windows[0];
  movePet(shell, -1280, 200);
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: true});
  assert.equal(pet.bounds.x, -1280);
  assert.equal(pet.bounds.width, 14, 'DIP handle must not be multiplied by the 2x scale factor');
  shell.screen.displays = [primary, {...left, scaleFactor: 1.5, workArea: {...left.workArea, y: -50, height: 900}}];
  shell.screen.emit('display-metrics-changed', {}, shell.screen.displays[1], ['workArea', 'scaleFactor']);
  within(pet.getBounds(), shell.screen.displays[1].workArea);
  assert.equal(pet.bounds.width, 14);
  shell.screen.displays = [primary];
  shell.screen.emit('display-removed', {}, left);
  assert.equal(shell.state().dock, null);
  assert.deepEqual([pet.bounds.width, pet.bounds.height], [240, 260]);
  within(pet.getBounds(), primary.workArea);
  shell.screen.displays = [{...primary, workArea: {x: 0, y: 0, width: 800, height: 600}}];
  shell.screen.primary = shell.screen.displays[0];
  pet.setPosition(1500, 700);
  shell.screen.emit('display-metrics-changed', {}, shell.screen.primary, ['workArea']);
  within(pet.getBounds(), shell.screen.primary.workArea);
});

test('undocking after a tiny work-area change restores the configured pet size', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0], size = petSize(DEFAULT_SETTINGS.scale);
  movePet(shell, 0, 300);
  const tinyDisplay = {...primary, workArea: {x: 0, y: 0, width: 160, height: 180}};
  shell.screen.displays = [tinyDisplay]; shell.screen.primary = tinyDisplay;
  shell.screen.emit('display-metrics-changed', {}, tinyDisplay, ['workArea']);
  within(pet.getBounds(), tinyDisplay.workArea);
  revealHandle(shell);
  assert.deepEqual(pet.getBounds(), tinyDisplay.workArea, 'The expanded dock still fits the tiny work area');

  shell.trays[0].emit('click');
  assert.equal(shell.state().dock, null);
  assert.deepEqual(pet.getBounds(), {x: 0, y: 0, ...size}, 'A free pet uses its configured size and a clamped position');
  shell.screen.displays = [primary]; shell.screen.primary = primary;
  shell.screen.emit('display-metrics-changed', {}, primary, ['workArea']);
  assert.deepEqual(pet.getBounds(), {x: 0, y: 0, ...size});
  within(pet.getBounds(), primary.workArea);
  assert.equal(shell.state().settings.scale, DEFAULT_SETTINGS.scale);
});

test('native minimum handle sizes stay on their dock edge through scaling and display changes', async (t) => {
  for (const [edge, x, y] of [['left', 0, 300], ['right', 1680, 300], ['top', 700, 0], ['bottom', 700, 780]]) {
    const shell = await createShell(t, {nativeMinimumSize: {width: 30, height: 36}});
    const pet = shell.windows[0];
    const checkEdge = area => {
      const bounds = pet.getBounds();
      within(bounds, area);
      if (edge === 'left') assert.equal(bounds.x, area.x);
      if (edge === 'right') assert.equal(bounds.x + bounds.width, area.x + area.width);
      if (edge === 'top') assert.equal(bounds.y, area.y);
      if (edge === 'bottom') assert.equal(bounds.y + bounds.height, area.y + area.height);
    };
    movePet(shell, x, y);
    assert.deepEqual(shell.state().dock, {edge, collapsed: true});
    assert.deepEqual([pet.bounds.width, pet.bounds.height], ['left', 'right'].includes(edge) ? [30, 64] : [64, 36]);
    checkEdge(primary.workArea);
    assert.deepEqual(shell.saved().position, {x, y}, 'Native handle adjustment must not overwrite the full-pet anchor');
    shell.invoke(pet, 'set-settings', {scale: 2});
    checkEdge(primary.workArea);
    const changed = {...primary, workArea: {x: -720, y: -100, width: 720, height: 600}};
    shell.screen.displays = [changed]; shell.screen.primary = changed;
    shell.screen.emit('display-metrics-changed', {}, changed, ['workArea']);
    checkEdge(changed.workArea);
    revealHandle(shell);
    assert.deepEqual([pet.bounds.width, pet.bounds.height], [384, 416]);
    checkEdge(changed.workArea);
  }
});

test('a native window too large for the selected work area cancels docking safely', async (t) => {
  const tinyDisplay = {...primary, workArea: {x: 0, y: 0, width: 20, height: 20}};
  const shell = await createShell(t, {displays: [tinyDisplay], nativeMinimumSize: {width: 30, height: 36}});
  const pet = shell.windows[0];
  movePet(shell, -10, -10);
  assert.equal(shell.state().dock, null);
  assert.equal(pet.visible, true);
  assert.deepEqual([pet.bounds.width, pet.bounds.height], [240, 260]);
  assert.deepEqual(pet.getPosition(), [0, 0]);
  assert.equal(shell.clock.intervals(), 0);
});

test('power pause reasons compose in either order and resume only when all reasons clear', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  for (const [first, second, clearFirst, clearSecond] of [
    ['lock-screen', 'suspend', 'unlock-screen', 'resume'],
    ['suspend', 'lock-screen', 'resume', 'unlock-screen'],
  ]) {
    shell.invoke(pet, 'set-settings', {globalGaze: true});
    shell.powerMonitor.emit(first); shell.powerMonitor.emit(second);
    assert.equal(pet.visible, false);
    assert.equal(shell.clock.intervals(), 0);
    shell.powerMonitor.emit(clearFirst);
    assert.equal(pet.visible, false);
    shell.powerMonitor.emit(clearSecond);
    assert.equal(pet.visible, true);
    assert.equal(shell.clock.intervals(), 1);
  }
});

test('user-hidden state survives lock and sleep, while explicit tray restore waits for resume', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'hide');
  shell.powerMonitor.emit('lock-screen'); shell.powerMonitor.emit('suspend');
  shell.powerMonitor.emit('unlock-screen'); shell.powerMonitor.emit('resume');
  assert.equal(pet.visible, false, 'System resume must not override a user hide');
  shell.powerMonitor.emit('lock-screen'); shell.trays[0].emit('click');
  assert.equal(pet.visible, false, 'Explicit restore stays suppressed while locked');
  shell.powerMonitor.emit('unlock-screen');
  assert.equal(pet.visible, true);
  shell.powerMonitor.emit('lock-screen'); shell.invoke(pet, 'hide'); shell.powerMonitor.emit('unlock-screen');
  assert.equal(pet.visible, false, 'A hide requested during lock survives unlock');
});

test('pending window readiness cannot revive a user-hidden, locked, or quitting window', async (t) => {
  const shell = await createShell(t, {deferReady: true});
  const pet = shell.windows[0];
  shell.invoke(pet, 'hide'); pet.ready();
  assert.equal(pet.visible, false);
  shell.trays[0].emit('click');
  shell.invoke(pet, 'show-settings');
  const settings = shell.windows[1];
  shell.powerMonitor.emit('lock-screen'); settings.ready();
  assert.equal(settings.visible, false);
  shell.powerMonitor.emit('unlock-screen');
  assert.equal(settings.visible, true, 'A settings request pending at lock is restored');
  settings.close(); shell.invoke(pet, 'show-settings');
  const pendingSettings = shell.windows[2];
  shell.app.quit(); pendingSettings.ready();
  assert.equal(pendingSettings.visible, false, 'A late load cannot resurrect a quitting window');
});

test('visible settings restore after pause without undoing a separate user hide', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  const settings = shell.windows[1];
  shell.invoke(pet, 'hide');
  shell.powerMonitor.emit('suspend');
  assert.equal(settings.visible, false);
  shell.powerMonitor.emit('resume');
  assert.equal(settings.visible, true);
  assert.equal(pet.visible, false);
});

test('global gaze sampling is opt-in, bounded, and stops while hidden, paused, dragging, or collapsed', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0], gaze = () => pet.webContents.sent.filter((event) => event.channel === 'andromeda:gaze');
  const reads = shell.screen.cursorReads;
  shell.clock.advance(1000);
  assert.equal(shell.screen.cursorReads, reads);
  assert.equal(shell.clock.intervals(), 0);
  shell.invoke(pet, 'set-settings', {globalGaze: true});
  shell.screen.cursor = {x: 10_000_000, y: -10_000_000}; shell.clock.advance(100);
  assert.deepEqual(gaze().at(-1).value, {x: 4096, y: -4096});
  let count = gaze().length;
  shell.invoke(pet, 'hide'); shell.clock.advance(1000);
  assert.equal(gaze().length, count);
  assert.equal(shell.clock.intervals(), 0);
  shell.trays[0].emit('click');
  shell.powerMonitor.emit('suspend'); shell.clock.advance(1000);
  assert.equal(gaze().length, count);
  shell.powerMonitor.emit('resume');
  const b = pet.getBounds(); shell.screen.cursor = {x: b.x + 20, y: b.y + 20}; shell.send('start-drag');
  shell.clock.advance(200); assert.equal(gaze().length, count);
  shell.send('cancel-drag'); movePet(shell, 0, 300);
  count = gaze().length; leaveHandle(shell); shell.clock.advance(1000);
  assert.equal(gaze().length, count);
  shell.invoke(pet, 'set-settings', {globalGaze: false});
  shell.invoke(pet, 'undock');
  assert.equal(shell.clock.intervals(), 0);
});

test('clickthrough requires a tray, is disabled while docked, and tray/reset recover it', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', {clickThrough: true});
  assert.equal(shell.state().clickThroughActive, true);
  assert.equal(pet.ignoreMouse, true); assert.equal(pet.focusable, false);
  const old = pet.getBounds(); movePet(shell, 0, 300);
  assert.deepEqual(pet.getBounds(), old, 'Clickthrough cannot accept forged drag gestures');
  shell.trays[0].emit('click');
  assert.equal(shell.state().clickThroughActive, false);
  assert.equal(shell.state().settings.clickThrough, false);
  assert.equal(pet.ignoreMouse, false); assert.equal(pet.focusable, true);
  movePet(shell, 0, 300); shell.invoke(pet, 'set-settings', {clickThrough: true});
  assert.equal(shell.state().clickThroughActive, false);
  assert.equal(pet.ignoreMouse, false);
  shell.invoke(pet, 'reset-position');
  assert.equal(shell.state().settings.clickThrough, false);
  assert.equal(shell.state().clickThroughActive, false);
});

test('unsupported clickthrough fails open with a reachable pet', async (t) => {
  const shell = await createShell(t, {ignoreMouseFails: true});
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', {clickThrough: true});
  assert.equal(shell.state().clickThroughActive, false);
  assert.equal(shell.state().settings.clickThrough, false);
  assert.equal(pet.ignoreMouse, false); assert.equal(pet.focusable, true);
  assert.equal(pet.visible, true);
});

test('destroyed tray cancels active clickthrough and restores taskbar access on the next poll', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', {clickThrough: true}); shell.trays[0].destroy();
  shell.clock.advance(100);
  assert.equal(pet.ignoreMouse, false); assert.equal(pet.focusable, true);
  assert.equal(pet.skipTaskbar, false);
  assert.equal(shell.state().trayAvailable, false);
  assert.equal(shell.state().settings.clickThrough, false);
  assert.equal(pet.visible, true);
  assert.throws(() => shell.invoke(pet, 'set-settings', {clickThrough: true}), /托盘不可用/);
});

test('a fresh startup never restores saved clickthrough or hidden/docked transient state', async (t) => {
  const shell = await createShell(t, {saved: {
    version: 1, settings: {...DEFAULT_SETTINGS, clickThrough: true}, position: {x: 0, y: 300},
    visible: false, userHidden: true, dock: {edge: 'left', collapsed: true},
  }});
  const pet = shell.windows[0];
  assert.equal(pet.visible, true);
  assert.equal(pet.ignoreMouse, false);
  assert.equal(shell.state().settings.clickThrough, false);
  assert.equal(shell.state().dock, null);
  assert.deepEqual([pet.bounds.width, pet.bounds.height], [240, 260]);
});

test('manual release-page action accepts no URL input and opens only the official fixed destination', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  assert.equal(await shell.invoke(pet, 'open-releases'), true);
  assert.deepEqual(shell.externalURLs, ['https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases']);
  assert.throws(() => shell.invoke(pet, 'open-releases', 'https://example.com'), /参数/);
  assert.throws(() => shell.handlers.get('andromeda:open-releases')({sender: pet.webContents, senderFrame: {url: pet.webContents.mainFrame.url}}), /不允许/);
  assert.equal(shell.externalURLs.length, 1);
  assert.equal(typeof shell.state().version, 'string');
});

test('shutdown clears timers and cannot be undone by power, tray, app, or pending hover events', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', {globalGaze: true});
  movePet(shell, 0, 300); revealHandle(shell); leaveHandle(shell);
  shell.powerMonitor.emit('suspend');
  shell.app.quit();
  const before = pet.calls.filter(([name]) => name === 'show').length;
  const bounds = pet.getBounds();
  shell.powerMonitor.emit('resume'); shell.powerMonitor.emit('unlock-screen');
  shell.app.emit('activate'); shell.app.emit('second-instance'); shell.trays[0].emit('click');
  shell.clock.advance(60_000);
  assert.equal(pet.visible, false);
  assert.equal(pet.calls.filter(([name]) => name === 'show').length, before);
  assert.deepEqual(pet.getBounds(), bounds);
  assert.equal(shell.clock.pending(), 0);
});

test('fast release commits actual movement even when every over-threshold move was throttled', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0], b = pet.getBounds();
  shell.screen.cursor = {x: b.x + 20, y: b.y + 20}; shell.send('start-drag');
  shell.screen.cursor.x += 4; shell.send('drag');
  shell.screen.cursor = {x: 20, y: 320}; shell.send('drag'); shell.send('end-drag');
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: true});
  assert.deepEqual(shell.saved().position, {x: 0, y: 300});
});

test('release over the collapsed handle waits for a pointer exit before hover can reveal', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0], b = pet.getBounds();
  shell.screen.cursor = {x: b.x + 5, y: b.y + b.height / 2}; shell.send('start-drag');
  shell.screen.cursor = {x: 5, y: 430}; shell.send('drag'); shell.send('end-drag');
  assert.deepEqual(shell.state().dock, {edge: 'left', collapsed: true});
  shell.clock.advance(1000);
  assert.equal(shell.state().dock.collapsed, true, 'Releasing over the new handle must not immediately pop it open');
  revealHandle(shell);
  assert.equal(shell.state().dock.collapsed, false);
});

test('fullscreen auto-hide is opt-in and requires both Windows helper and tray capability', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  assert.equal(shell.state().fullscreenAvailable, true);
  assert.equal(shell.state().settings.autoHideFullscreen, false);
  assert.equal(shell.state().fullscreenSuppressed, false);
  assert.equal(shell.fullscreenMonitors.length, 0);
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  assert.equal(shell.fullscreenMonitors.length, 1);
  assert.equal(shell.fullscreenMonitors[0].starts, 1);
  assert.equal(shell.fullscreenMonitors[0].helperPath, shell.fullscreenHelperPath);
  assert.equal(shell.saved().settings.autoHideFullscreen, true);

  for (const options of [
    { platform: 'linux' }, { platform: 'darwin' }, { fullscreenHelperExists: false }, { trayWorks: false },
  ]) {
    const unavailable = await createShell(t, { ...options, saved: {
      version: 1, settings: { ...DEFAULT_SETTINGS, autoHideFullscreen: true }, position: null,
    } });
    assert.equal(unavailable.state().settings.autoHideFullscreen, false);
    assert.equal(unavailable.state().fullscreenAvailable, options.trayWorks === false);
    assert.equal(unavailable.fullscreenMonitors.length, 0);
    assert.throws(() => unavailable.invoke(unavailable.windows[0], 'set-settings', { autoHideFullscreen: true }), /Windows.*托盘/);
    assert.equal(unavailable.windows[0].visible, true);
  }
});

test('saved fullscreen opt-in uses the packaged helper path without restoring hidden state', async (t) => {
  const shell = await createShell(t, { packaged: true, saved: {
    version: 1, settings: { ...DEFAULT_SETTINGS, autoHideFullscreen: true }, position: null,
  } });
  assert.equal(shell.fullscreenMonitors.length, 1);
  assert.equal(shell.fullscreenMonitors[0].helperPath, shell.fullscreenHelperPath);
  assert.equal(shell.windows[0].visible, true, 'Only a current detector observation can suppress the window');
  assert.equal(shell.state().fullscreenSuppressed, false);
});

test('fullscreen matching uses converted physical monitor centers and only suppresses the pet display', async (t) => {
  const left = {
    id: 2, scaleFactor: 1.5,
    bounds: { x: -1600, y: -200, width: 1600, height: 1000 },
    workArea: { x: -1600, y: -200, width: 1600, height: 960 },
  };
  const physicalLeft = { x: -2560, y: -1200, width: 2560, height: 1600 };
  const physicalPrimary = { x: 0, y: 0, width: 3840, height: 2160 };
  const shell = await createShell(t, {
    displays: [primary, left],
    screenToDipPoint(point) {
      if (point.x < 0) {
        assert.deepEqual(point, { x: -1280, y: -400 });
        // Origins are deliberately not related by simple scale multiplication.
        return { x: -800, y: 300 };
      }
      assert.deepEqual(point, { x: 1920, y: 1080 });
      return { x: 960, y: 540 };
    },
  });
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  const monitor = shell.fullscreenMonitors[0];
  monitor.snapshot(physicalLeft);
  assert.equal(pet.visible, true, 'Fullscreen on another display does not hide the pet');
  movePet(shell, -1000, 200);
  monitor.snapshot(physicalPrimary);
  assert.equal(pet.visible, true);
  monitor.snapshot(physicalLeft);
  assert.equal(pet.visible, false);
  assert.equal(shell.state().fullscreenSuppressed, true);
  assert.equal(shell.screen.physicalPoints.length, 3);
  monitor.snapshot(null);
  assert.equal(pet.visible, true);
  assert.equal(shell.state().fullscreenSuppressed, false);
});

test('fullscreen pause restores pet and settings without focus and preserves a manual hide', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  const settings = shell.windows[1];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true, globalGaze: true });
  const monitor = shell.fullscreenMonitors[0];
  const focusCount = (window) => window.calls.filter(([name]) => name === 'focus').length;
  const petFocus = focusCount(pet), settingsFocus = focusCount(settings);
  assert.equal(shell.clock.intervals(), 1);
  monitor.snapshot(primary.bounds);
  assert.equal(pet.visible, false);
  assert.equal(settings.visible, false);
  assert.equal(shell.clock.intervals(), 0, 'Animation/cursor polling stops independently of the detector');
  assert.equal(monitor.stops, 0, 'The fullscreen heartbeat must survive its own suppression');
  monitor.snapshot(null);
  assert.equal(pet.visible, true);
  assert.equal(settings.visible, true);
  assert.ok(pet.calls.some(([name]) => name === 'showInactive'));
  assert.ok(settings.calls.some(([name]) => name === 'showInactive'));
  assert.equal(focusCount(pet), petFocus);
  assert.equal(focusCount(settings), settingsFocus);
  assert.equal(shell.clock.intervals(), 1);

  shell.invoke(pet, 'hide');
  monitor.snapshot(primary.bounds); monitor.snapshot(null);
  assert.equal(pet.visible, false, 'Automatic recovery does not override a deliberate hide');
  assert.equal(settings.visible, true);
  assert.equal(shell.state().settings.autoHideFullscreen, true);
});

test('fullscreen detector stops through nested lock/suspend and restarts only after both clear', async (t) => {
  for (const [first, second, clearFirst, clearSecond] of [
    ['lock-screen', 'suspend', 'unlock-screen', 'resume'],
    ['suspend', 'lock-screen', 'resume', 'unlock-screen'],
  ]) {
    const shell = await createShell(t);
    const pet = shell.windows[0];
    shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
    const initial = shell.fullscreenMonitors[0];
    initial.snapshot(primary.bounds);
    shell.powerMonitor.emit(first); shell.powerMonitor.emit(second);
    assert.equal(initial.stops, 1);
    assert.equal(pet.visible, false);
    assert.equal(shell.state().fullscreenSuppressed, false, 'Old fullscreen observations do not survive a desktop pause');
    initial.snapshot(null); initial.error();
    assert.equal(shell.state().settings.autoHideFullscreen, true, 'Late callbacks from a stopped detector are ignored');
    shell.powerMonitor.emit(clearFirst);
    assert.equal(shell.fullscreenMonitors.length, 1);
    assert.equal(pet.visible, false);
    shell.powerMonitor.emit(clearSecond);
    assert.equal(shell.fullscreenMonitors.length, 2);
    assert.equal(shell.fullscreenMonitors[1].starts, 1);
    assert.equal(pet.visible, true);
    assert.equal(pet.calls.filter(([name]) => name === 'focus').length, 0);
    initial.snapshot(primary.bounds);
    assert.equal(pet.visible, true, 'A previous child cannot suppress the resumed desktop');
    shell.fullscreenMonitors[1].snapshot(primary.bounds);
    assert.equal(pet.visible, false);
  }
});

test('explicit tray, reset and second-instance recovery disable fullscreen opt-in', async (t) => {
  for (const recover of [
    (shell) => shell.trays[0].emit('click'),
    (shell) => shell.invoke(shell.windows[0], 'reset-position'),
    (shell) => shell.app.emit('second-instance'),
  ]) {
    const shell = await createShell(t);
    const pet = shell.windows[0];
    shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
    const monitor = shell.fullscreenMonitors[0];
    monitor.snapshot(primary.bounds);
    assert.equal(pet.visible, false);
    recover(shell);
    assert.equal(pet.visible, true);
    assert.equal(shell.state().settings.autoHideFullscreen, false);
    assert.equal(shell.saved().settings.autoHideFullscreen, false);
    assert.equal(shell.state().fullscreenSuppressed, false);
    assert.equal(monitor.stops, 1);
    monitor.snapshot(primary.bounds); monitor.error();
    assert.equal(pet.visible, true);
    assert.equal(shell.state().fullscreenError, null);
  }
});

test('opening settings during fullscreen suppression is an explicit recovery route', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  const monitor = shell.fullscreenMonitors[0];
  monitor.snapshot(primary.bounds);
  shell.invoke(pet, 'show-settings');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shell.windows[1].visible, true);
  assert.equal(pet.visible, true);
  assert.equal(shell.state().settings.autoHideFullscreen, false);
  assert.equal(monitor.stops, 1);
});

test('fullscreen detector failure disables opt-in, fails open and permits an explicit retry', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  const monitor = shell.fullscreenMonitors[0];
  monitor.snapshot(primary.bounds); monitor.error();
  assert.equal(pet.visible, true);
  assert.equal(shell.state().settings.autoHideFullscreen, false);
  assert.equal(shell.saved().settings.autoHideFullscreen, false);
  assert.equal(shell.state().fullscreenSuppressed, false);
  assert.match(shell.state().fullscreenError, /已关闭自动隐藏/);
  assert.equal(monitor.stops, 1);
  assert.equal(pet.calls.filter(([name]) => name === 'focus').length, 0);
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  assert.equal(shell.state().fullscreenError, null);
  assert.equal(shell.fullscreenMonitors.length, 2);
  monitor.error(); monitor.snapshot(primary.bounds);
  assert.equal(shell.state().settings.autoHideFullscreen, true);
  assert.equal(pet.visible, true);
  shell.fullscreenMonitors[1].snapshot(primary.bounds);
  assert.equal(pet.visible, false);
});

test('lost tray recovers a fullscreen-hidden pet and taskbar access at the next heartbeat', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  const monitor = shell.fullscreenMonitors[0];
  monitor.snapshot(primary.bounds);
  shell.trays[0].destroy(); monitor.snapshot(primary.bounds);
  assert.equal(pet.visible, true);
  assert.equal(pet.skipTaskbar, false);
  assert.equal(shell.state().trayAvailable, false);
  assert.equal(shell.state().settings.autoHideFullscreen, false);
  assert.equal(shell.saved().settings.autoHideFullscreen, false);
  assert.equal(shell.state().fullscreenSuppressed, false);
  assert.equal(monitor.stops, 1);
});

test('display topology changes discard fullscreen observations until a new heartbeat', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true });
  const monitor = shell.fullscreenMonitors[0];
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    monitor.snapshot(primary.bounds);
    assert.equal(pet.visible, false);
    shell.screen.emit(event, {}, primary, ['bounds']);
    assert.equal(pet.visible, true);
    assert.equal(shell.state().fullscreenSuppressed, false);
    shell.invoke(pet, 'set-settings', { scale: 1 });
    assert.equal(pet.visible, true, 'Another settings update cannot reuse the discarded monitor geometry');
    monitor.snapshot(primary.bounds);
    assert.equal(pet.visible, false);
    assert.equal(monitor.stops, 0);
  }
  shell.screen.screenToDipPoint = () => { throw new Error('display disappeared'); };
  monitor.snapshot(primary.bounds);
  assert.equal(pet.visible, true, 'Unavailable native geometry must fail open');
  assert.equal(shell.state().fullscreenSuppressed, false);
});

test('quit stops fullscreen helper once and ignores all of its delayed callbacks', async (t) => {
  const shell = await createShell(t);
  const pet = shell.windows[0];
  shell.invoke(pet, 'set-settings', { autoHideFullscreen: true, globalGaze: true });
  const monitor = shell.fullscreenMonitors[0];
  monitor.snapshot(primary.bounds);
  const showCount = pet.calls.filter(([name]) => name === 'show').length;
  shell.invoke(pet, 'quit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(monitor.stops, 1);
  monitor.snapshot(null); monitor.snapshot(primary.bounds); monitor.error();
  shell.powerMonitor.emit('resume'); shell.powerMonitor.emit('unlock-screen');
  shell.app.emit('second-instance'); shell.trays[0].emit('click');
  shell.clock.advance(60_000);
  assert.equal(shell.fullscreenMonitors.length, 1);
  assert.equal(pet.visible, false);
  assert.equal(pet.calls.filter(([name]) => name === 'show').length, showCount);
  assert.equal(shell.clock.pending(), 0);
  assert.equal(shell.state().fullscreenError, null);
});
