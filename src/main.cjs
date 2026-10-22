'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, session, protocol, dialog, powerMonitor, shell, safeStorage, desktopCapturer } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const {
  createSettingsStore, validateSettingsPatch, petSize, clampPosition,
} = require('./settings.cjs');
const { dockAt, dockBounds, findDisplay, hitTest, HIDE_DELAY } = require('./docking.cjs');
const { applyDockWindowBounds } = require('./dock-window.cjs');
const { createFullscreenMonitor } = require('./fullscreen-monitor.cjs');
const { createCompanionHost } = require('./companion-host.cjs');
const {createMotionState, setMotionMode, syncMotionBounds, throwMotion, stepMotion} = require('./motion.cjs');
const {createShortcutStore} = require('./services/shortcuts.cjs');
const {SCHEME:DEEP_LINK_SCHEME,parseDeepLink}=require('./deep-link.cjs');
const {createCharacterStore}=require('./services/character-store.cjs');
const {assertPayloadBudget}=require('./ipc-budget.cjs');

const RELEASES_URL = 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases';
const VERSION = require('../package.json').version;
const APP_NAME = '星璇（Andromeda）桌宠';
const ROOT = path.resolve(__dirname, '..');
const PET_URL = 'andromeda://app/src/pet.html';
const SETTINGS_URL = 'andromeda://app/src/settings.html';
const COMPANION_URL = 'andromeda://app/src/companion.html';
const LINKS = Object.freeze({home: 'https://starwright.xyz/', xingxuan: 'https://starwright.xyz/tools/xingxuan/', modelwright: 'https://starwright.xyz/tools/modelwright/', releases: RELEASES_URL});
const ICON_PATH = path.join(ROOT, 'assets', 'icon.png');
const FULLSCREEN_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'windows-fullscreen.exe')
  : path.join(ROOT, 'dist', 'native', 'windows-fullscreen.exe');
const fullscreenAvailable = process.platform === 'win32' && existsSync(FULLSCREEN_HELPER);
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
let companionWindow = null;
let companionHost = null;
let shortcutStore = null;
let characterStore = null, characterReady;
let voiceAllowedUntil = 0;
let movementTimer = null, movementState = null, movementTime = 0, movementActionAt = 0;
let rhythmAt = 0;
let pendingDeepLink = null;
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
let fullscreenMonitor = null;
let fullscreenSnapshot = null;
let fullscreenError = null;
let lastPublicState = null;
const pauses = new Set();
function validateCharacterImage(value){
  const decoded=nativeImage.createFromBuffer(value.image),size=decoded.getSize();
  if(decoded.isEmpty()||size.width!==value.pack.atlas.width||size.height!==value.pack.atlas.height)throw new Error('角色图片无法解码或尺寸不符');
}

function paused() { return pauses.size > 0; }
function fullscreenWanted() {
  return !quitting && fullscreenAvailable && hasTray() && preferences.settings.autoHideFullscreen
    && !pauses.has('locked') && !pauses.has('suspended');
}

function applyFullscreenSnapshot(monitor) {
  fullscreenSnapshot = monitor;
  let suppress = false;
  if (monitor && fullscreenWanted() && isAlive(petWindow)) {
    try {
      // Native monitor coordinates are physical pixels. Convert a point through
      // Electron; multiplying mixed-DPI desktop origins by scale is incorrect.
      const center = screen.screenToDipPoint({
        x: Math.round(monitor.x + monitor.width / 2),
        y: Math.round(monitor.y + monitor.height / 2),
      });
      const display = screen.getAllDisplays().find((item) => hitTest(center, item.bounds));
      suppress = Boolean(display && screen.getDisplayMatching(normalBounds()).id === display.id);
    } catch { /* A changed/unavailable display must fail open. */ }
  }
  if (suppress && !pauses.has('fullscreen')) pauseDesktop('fullscreen');
  else if (!suppress && pauses.has('fullscreen')) resumeDesktop('fullscreen');
}

function stopFullscreenMonitor() {
  const monitor = fullscreenMonitor;
  fullscreenMonitor = null; // Ignore callbacks from an intentionally stopped child.
  if (monitor) monitor.stop();
  applyFullscreenSnapshot(null);
}

function updateFullscreenMonitor() {
  // This has its own heartbeat: the desktop/animation timer stops while hidden.
  if (!fullscreenWanted()) { stopFullscreenMonitor(); return; }
  if (fullscreenMonitor) return;
  const monitor = createFullscreenMonitor({
    helperPath: FULLSCREEN_HELPER,
    onChange(value) {
      if (fullscreenMonitor !== monitor) return;
      if (!hasTray()) {
        preferences.settings.autoHideFullscreen = false;
        if (isAlive(petWindow)) petWindow.setSkipTaskbar(false);
        stopFullscreenMonitor(); savePreferences(); updateTrayMenu(); publishState();
        return;
      }
      applyFullscreenSnapshot(value);
    },
    onError() {
      if (fullscreenMonitor !== monitor) return;
      fullscreenError = '全屏检测暂时不可用，已关闭自动隐藏；可重新开启后再试。';
      preferences.settings.autoHideFullscreen = false;
      stopFullscreenMonitor(); savePreferences(); updateTrayMenu(); publishState();
    },
  });
  fullscreenMonitor = monitor;
  monitor.start();
}

function disableFullscreenAutoHide() {
  preferences.settings.autoHideFullscreen = false;
  stopFullscreenMonitor();
}

function fittedPetBounds(position, { cursor, display } = {}) {
  const nominal = petSize(preferences.settings.scale);
  const target = display || (position && findDisplay({ ...nominal, ...position }, screen.getAllDisplays(), cursor)) || screen.getPrimaryDisplay();
  const size = petSize(preferences.settings.scale, target);
  return { ...clampPosition(position, size, [target], target), ...size };
}

function applyFreePetBounds(next, cursor) {
  const current = petWindow.getBounds();
  if (current.width !== next.width || current.height !== next.height) petWindow.setBounds(next);
  else if (current.x !== next.x || current.y !== next.y) petWindow.setPosition(next.x, next.y);
  // Some platforms impose a native minimum. Clamp the measured rectangle on
  // the intended display, even if that minimum exceeds an unusual work area.
  const measured = petWindow.getBounds();
  if (measured.width !== next.width || measured.height !== next.height) {
    const target = findDisplay(next, screen.getAllDisplays(), cursor) || screen.getPrimaryDisplay();
    const position = clampPosition(measured, measured, [target], target);
    if (measured.x !== position.x || measured.y !== position.y) petWindow.setPosition(position.x, position.y);
  }
}

function normalBounds() {
  if (!isAlive(petWindow)) return null;
  if (dock) {
    const layout = dockBounds(dock, petSize(preferences.settings.scale), screen.getAllDisplays());
    if (layout) return layout.expanded;
    return fittedPetBounds(preferences.position);
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
  updateMovement();
  const needed = !quitting && !paused() && isAlive(petWindow) && petWindow.isVisible()
    && Boolean(dock || preferences.settings.globalGaze || clickThroughActive);
  if (needed && !desktopTimer) desktopTimer = setInterval(pollDesktop, 100);
  if (!needed && desktopTimer) { clearInterval(desktopTimer); desktopTimer = null; }
}

function updateMovement() {
  const state = companionHost?.publicState(), mode = state?.preferences?.movement || 'off';
  const needed = mode !== 'off' && !quitting && !paused() && !dock && !dragSession && !clickThroughActive
    && !state?.focusing && !state?.preferences?.reducedMotion && isAlive(petWindow) && petWindow.isVisible();
  if (!needed) {if (movementTimer) clearTimeout(movementTimer);movementTimer = null;movementState = null;return;}
  if (movementTimer) return;
  if (!movementState) movementState = createMotionState(petWindow.getBounds(), {mode});
  else if (movementState.mode !== mode) movementState = setMotionMode(movementState, mode);
  if (mode === 'toss' && !movementState.active) return;
  movementTime = Date.now();movementTimer = setTimeout(pollMovement, 33);
}
function pollMovement() {
    movementTimer = null;
    if (!isAlive(petWindow) || !movementState) return;
    const current = companionHost.publicState(), nextMode = current.preferences.movement;
    if (quitting || paused() || dock || dragSession || clickThroughActive || current.focusing || current.preferences.reducedMotion || !petWindow.isVisible() || nextMode === 'off') {updateMovement();return;}
    if (nextMode !== movementState.mode) movementState = setMotionMode(movementState,nextMode);
    // Native dragging, scale changes and display changes are authoritative.
    const actual = petWindow.getBounds();
    if (Math.abs(actual.x-Math.round(movementState.x))>1 || Math.abs(actual.y-Math.round(movementState.y))>1 || actual.width!==movementState.width) movementState=syncMotionBounds(movementState,actual);
    const now=Date.now(), result=stepMotion(movementState,{deltaMs:Math.max(0,now-movementTime),workArea:screen.getDisplayMatching(actual).workArea,
      pointer:screen.getCursorScreenPoint(),hidden:!petWindow.isVisible(),paused:paused()||!!dock||!!current.focusing||clickThroughActive,dragging:!!dragSession,reducedMotion:current.preferences.reducedMotion});
    movementState=result.state;movementTime=now;
    if(result.moved)petWindow.setPosition(result.bounds.x,result.bounds.y);
    if(result.action!=='idle' && now-movementActionAt>2000) {movementActionAt=now;emitCompanionEvent({id:'move-'+now,kind:'motion',action:result.action,text:'',priority:15});}
    if (movementState.mode !== 'toss' || movementState.active) movementTimer = setTimeout(pollMovement, movementState.mode === 'follow' && !result.moved ? 100 : 33);
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
  // An existing settings window may still be waiting for ready-to-show.
  if (first) settingsBeforePause = Boolean(isAlive(settingsWindow));
  if (isAlive(settingsWindow)) settingsWindow.hide();
  if (isAlive(petWindow)) petWindow.hide();
  applyClickThrough(); updateDesktopTimer(); publishState();
  if (reason !== 'fullscreen') updateFullscreenMonitor();
}

function resumeDesktop(reason) {
  if (quitting) return;
  pauses.delete(reason);
  if (reason === 'locked' || reason === 'suspended') void companionHost?.refresh().catch(() => {});
  if (paused()) { if (reason !== 'fullscreen') updateFullscreenMonitor(); return; }
  clampPetPosition();
  if (!userHidden && isAlive(petWindow)) petWindow.showInactive();
  if (settingsBeforePause && isAlive(settingsWindow)) settingsWindow.showInactive();
  settingsBeforePause = false;
  applyClickThrough(); updateDesktopTimer(); publishState();
  if (reason !== 'fullscreen') updateFullscreenMonitor();
}

function isAlive(window) { return window && !window.isDestroyed(); }
function hasTray() { return tray !== null && !tray.isDestroyed(); }

function state() {
  const requestedSize = petSize(preferences.settings.scale);
  const bounds = normalBounds();
  const displayedSize = bounds ? { width: bounds.width, height: bounds.height } : requestedSize;
  return {
    settings: { ...preferences.settings },
    geometry: { requestedSize, displayedSize, fittedToWorkArea: displayedSize.width < requestedSize.width || displayedSize.height < requestedSize.height },
    visible: Boolean(isAlive(petWindow) && petWindow.isVisible()),
    trayAvailable: hasTray(),
    persistenceError,
    version: VERSION,
    companion: companionHost?.publicState() || null,
    dock: dock ? { edge: dock.edge, collapsed: dock.collapsed } : null,
    clickThroughActive,
    fullscreenAvailable,
    fullscreenSuppressed: pauses.has('fullscreen'),
    fullscreenError,
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

function clampPetPosition(cursor) {
  if (!isAlive(petWindow)) return;
  if (dock) {
    if (applyDockWindowBounds(petWindow, dock, petSize(preferences.settings.scale), screen.getAllDisplays())) {
      rememberPosition(true); return;
    }
    const position = preferences.position;
    dock = null;
    applyFreePetBounds(fittedPetBounds(position, { cursor }), cursor);
  } else {
    const bounds = petWindow.getBounds();
    applyFreePetBounds(fittedPetBounds(bounds, { cursor }), cursor);
  }
  rememberPosition(true);
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function moveDraggedPet(cursor) {
  const { origin, cursor: initial } = dragSession;
  const translated = { ...origin, x: origin.x + cursor.x - initial.x, y: origin.y + cursor.y - initial.y };
  const target = findDisplay(translated, screen.getAllDisplays(), cursor) || screen.getPrimaryDisplay();
  const size = petSize(preferences.settings.scale, target);
  // Keep the grabbed point under the pointer when a new monitor requires a
  // smaller temporary size. Restore the requested size on a larger monitor.
  const next = {
    x: Math.round(cursor.x - (initial.x - origin.x) * size.width / origin.width),
    y: Math.round(cursor.y - (initial.y - origin.y) * size.height / origin.height),
    ...size,
  };
  const bounds = petWindow.getBounds();
  if (bounds.width !== next.width || bounds.height !== next.height) petWindow.setBounds(next);
  else petWindow.setPosition(next.x, next.y);
}

function stopDrag(shouldDock = false) {
  if (!dragSession) return;
  let moved = dragSession.moved;
  let cursor;
  if (shouldDock && isAlive(petWindow) && !paused()) {
    cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dragSession.cursor.x, dy = cursor.y - dragSession.cursor.y;
    moved ||= Math.hypot(dx, dy) >= 5;
    if (moved) {
      dock = null;
      moveDraggedPet(cursor);
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
  clampPetPosition(moved ? cursor : undefined);
  applyClickThrough(); updateDesktopTimer(); publishState();
}

function restorePet() {
  if (!isAlive(petWindow) || quitting) return;
  stopDrag();
  userHidden = false;
  // Tray, reset and second-instance are unconditional recovery routes.
  preferences.settings.clickThrough = false;
  disableFullscreenAutoHide();
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
  stopFullscreenMonitor();
  rememberPosition(true);
  app.quit();
}

function applySettings(patch) {
  const clean = validateSettingsPatch(patch);
  if (clean.clickThrough && !hasTray()) throw new Error('系统托盘不可用，无法安全开启点击穿透。');
  if (clean.autoHideFullscreen && (!fullscreenAvailable || !hasTray())) {
    throw new Error('全屏自动隐藏需要 Windows 检测组件和可用系统托盘。');
  }
  stopDrag();
  const old = normalBounds();
  preferences.settings = { ...preferences.settings, ...clean };
  if (Object.hasOwn(clean, 'autoHideFullscreen')) fullscreenError = null;
  if (dock && !preferences.settings.edgeDock) undockPet();
  if (isAlive(petWindow)) {
    if (dock) {
      setDockCollapsed(dock.collapsed);
    } else {
      // Keep the bottom-center fixed when scaling, then ensure visibility.
      const display = findDisplay(old, screen.getAllDisplays()) || screen.getPrimaryDisplay();
      const size = petSize(preferences.settings.scale, display);
      const bounds = fittedPetBounds({
        x: old.x + (old.width - size.width) / 2,
        y: old.y + old.height - size.height,
      }, { display });
      applyFreePetBounds(bounds);
      const actual = petWindow.getBounds();
      preferences.position = { x: actual.x, y: actual.y };
    }
    petWindow.setAlwaysOnTop(preferences.settings.alwaysOnTop);
  }
  applyClickThrough(); updateDesktopTimer();
  updateFullscreenMonitor();
  if (fullscreenMonitor) applyFullscreenSnapshot(fullscreenSnapshot);
  savePreferences(); updateTrayMenu(); publishState();
  return state();
}

function resetPosition() {
  stopDrag();
  undockPet();
  if (isAlive(petWindow)) {
    applyFreePetBounds(fittedPetBounds(null, { display: screen.getPrimaryDisplay() }));
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

function openLink(key) {
  if (!Object.hasOwn(LINKS, key)) throw new TypeError('未知的快捷入口');
  return shell.openExternal(LINKS[key]).then(() => true);
}

function emitCompanionEvent(event) {
  // Passive events never restore a hidden window or change click-through/fullscreen preferences.
  if (isAlive(petWindow) && petWindow.isVisible() && !paused() && !clickThroughActive && !dock?.collapsed) {
    petWindow.webContents.send('andromeda:event', event);
  }
}

function showCompanion() {
  if (quitting || pauses.has('locked') || pauses.has('suspended')) return;
  if (isAlive(companionWindow)) { companionWindow.show(); companionWindow.focus(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  companionWindow = new BrowserWindow({width: Math.min(1080, area.width), height: Math.min(780, area.height),
    minWidth: Math.min(640, area.width), minHeight: Math.min(540, area.height), title: '星璇 · 陪伴空间', icon: ICON_PATH,
    backgroundColor: '#101624', show: false, webPreferences: webPreferences()});
  secureWindow(companionWindow);
  companionWindow.once('ready-to-show', () => { if (!quitting && !paused() && isAlive(companionWindow)) companionWindow.show(); });
  const current = companionWindow;
  companionWindow.on('show', () => {void companionHost?.state().then(value => {
    if (!quitting && isAlive(current) && current === companionWindow && current.isVisible()) current.webContents.send('andromeda:companion', value);
  }).catch(() => {});});
  companionWindow.on('closed', () => { companionWindow = null; voiceAllowedUntil = 0; companionHost?.cancelAssistant(); if(isAlive(petWindow))petWindow.webContents.send('andromeda:rhythm',0); });
  loadWindow(companionWindow, COMPANION_URL);
}

function menuTemplate() {
  return [
    { label: APP_NAME, enabled: false },
    { label: '一款开发中的桌宠', enabled: false },
    { type: 'separator' },
    { label: '显示星璇', click: restorePet },
    { label: '暂时隐藏', enabled: hasTray(), click: () => hidePet() },
    { label: '设置…', click: showSettings },
    { label: '陪伴空间 · 专注、待办、对话', click: showCompanion },
    { label: '去星匠网站看看', click: () => { openLink('home').catch(() => {}); } },
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
    { label: '全屏时自动隐藏（实验）', type: 'checkbox', checked: preferences.settings.autoHideFullscreen,
      enabled: fullscreenAvailable && hasTray(), click: (item) => applySettings({ autoHideFullscreen: item.checked }) },
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
  const candidates = petOnly ? [[petWindow, PET_URL]] : [[petWindow, PET_URL], [settingsWindow, SETTINGS_URL], [companionWindow, COMPANION_URL]];
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
  handle('andromeda:show-companion', () => { showCompanion(); return true; });
  handle('andromeda:interaction', (kind) => {
    if (!['pet', 'greet', 'play', 'thanks'].includes(kind)) throw new TypeError('未知的互动');
    return companionHost?.dispatch({type: 'interaction', kind}).then(() => true);
  }, true);
  function privateHandle(channel, callback) {
    ipcMain.handle(channel, (event, payload) => {
      // A disappearing audio panel may send its final zero after the window closes.
      // This acknowledgement performs no operation and grants no private access.
      if(channel==='andromeda:rhythm'&&payload===0&&(quitting||!isAlive(companionWindow)||pauses.has('locked')||pauses.has('suspended')))return false;
      if (!trustedSender(event) || event.sender !== companionWindow?.webContents) throw new Error('请从陪伴空间操作');
      if (quitting || pauses.has('locked') || pauses.has('suspended')) throw new Error('当前会话已暂停');
      if (payload !== undefined) assertPayloadBudget(payload);
      return callback(payload);
    });
  }
  privateHandle('andromeda:companion-state', () => companionHost.state());
  privateHandle('andromeda:companion-command', command => companionHost.dispatch(command));
  privateHandle('andromeda:assistant', command => companionHost.assistantCall(command));
  privateHandle('andromeda:task-bridge', enabled => companionHost.taskBridge(enabled));
  privateHandle('andromeda:shortcuts', async payload => {
    if (!payload || !['list','add','remove','launch'].includes(payload.action) || Object.keys(payload).some(key => !['action','id'].includes(key))) throw new TypeError('未知的快捷应用操作');
    if (payload.action === 'add') {
      if (process.platform !== 'win32') throw new Error('选择应用目前仅在 Windows 提供');
      const result = await dialog.showOpenDialog(companionWindow,{title:'选择要加入快捷入口的应用',properties:['openFile'],filters:[{name:'Windows 应用或快捷方式',extensions:['exe','lnk']}]});
      if (!result.canceled && result.filePaths.length === 1) shortcutStore.add({name:path.basename(result.filePaths[0],path.extname(result.filePaths[0])),path:result.filePaths[0]});
    } else if (payload.action === 'remove') shortcutStore.remove(payload.id);
    else if (payload.action === 'launch') await shortcutStore.launch(payload.id);
    return shortcutStore.list();
  });
  privateHandle('andromeda:toss', () => {
    updateMovement();
    if (!movementState || movementState.mode !== 'toss') throw new Error('请先开启轻抛模式，并将星璇移出边缘收纳');
    movementState = throwMotion(movementState,{velocityX:180,velocityY:-320});updateMovement();return true;
  });
  privateHandle('andromeda:rhythm', level => {
    if (!Number.isFinite(level) || level < 0 || level > 1) throw new TypeError('无效的节奏信号');
    if (level && Date.now()-rhythmAt < 100) return false;
    rhythmAt=Date.now();
    const publicState=companionHost.publicState();
    if(isAlive(petWindow))petWindow.webContents.send('andromeda:rhythm',petWindow.isVisible()&&!paused()&&!dock&&!dragSession&&!publicState?.focusing&&!publicState?.preferences.reducedMotion?level:0);
    return true;
  });
  privateHandle('andromeda:export-character', async data => {
    const {createCharacterArchive} = require('./services/character-archive.cjs');
    const clean = await createCharacterArchive(data,{originalImage:await fs.readFile(path.join(__dirname,'../assets/andromeda.png'))});
    validateCharacterImage(clean);
    const result = await dialog.showSaveDialog(companionWindow, {defaultPath: clean.pack.id + '.character.zip', filters: [{name: '角色包（图片与动作）', extensions: ['zip']}]});
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, clean.archive); return true;
  });
  handle('andromeda:character',async()=>{await characterReady;return characterStore?.snapshot()||null;});
  privateHandle('andromeda:install-character',async action=>{
    if(!['import','clear'].includes(action))throw new TypeError('未知的角色操作');
    await characterReady;
    if(action==='clear')await characterStore.clear();
    else{
      const result=await dialog.showOpenDialog(companionWindow,{title:'导入并使用角色包',properties:['openFile'],filters:[{name:'星璇编辑器角色包',extensions:['zip']}]});
      if(result.canceled||result.filePaths.length!==1)return {cancelled:true};
      const file=result.filePaths[0];if((await fs.stat(file)).size>12*1024*1024)throw new Error('角色包不能超过 12 MiB');
      await characterStore.install(await fs.readFile(file));
    }
    const current=characterStore.snapshot();
    if(isAlive(petWindow))petWindow.webContents.send('andromeda:character',current);
    return {name:current?.pack.name||null};
  });
  privateHandle('andromeda:restore-backup', async payload => {
    if (!payload || !['preview','restore'].includes(payload.action) || Object.keys(payload).some(key=>!['action','data'].includes(key))) throw new TypeError('无效的恢复请求');
    return payload.action==='preview' ? companionHost.previewRestore(payload.data) : companionHost.restoreBackup({backup:payload.data,confirmed:true});
  });
  privateHandle('andromeda:open-link', openLink);
  privateHandle('andromeda:voice-permission', () => { voiceAllowedUntil = Date.now() + 60_000; return true; });
  privateHandle('andromeda:autostart', enabled => {
    if (typeof enabled !== 'boolean') throw new TypeError('无效的开机启动设置');
    if (!app.isPackaged || !['win32', 'darwin'].includes(process.platform)) throw new Error('开机启动仅在已打包的 Windows/macOS 应用中可用');
    app.setLoginItemSettings({openAtLogin: enabled}); return {enabled: app.getLoginItemSettings().openAtLogin};
  });
  privateHandle('andromeda:register-deep-link', enabled => {
    if(typeof enabled!=='boolean')throw new TypeError('无效的网页入口设置');
    if(!app.isPackaged)throw new Error('请在解压后的正式程序中启用网页唤起入口');
    const ok=enabled?app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME):app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    if(!ok)throw new Error('系统没有应用这项设置，请检查默认应用设置');
    return {enabled:app.isDefaultProtocolClient(DEEP_LINK_SCHEME)};
  });
  privateHandle('andromeda:export', async kind => {
    const data = await companionHost.exportData(kind);
    const result = await dialog.showSaveDialog(companionWindow, {defaultPath: `andromeda-${kind}.json`, filters: [{name: 'JSON', extensions: ['json']}]});
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), {mode: 0o600}); return true;
  });
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
    dragSession = { cursor, origin: bounds, moved: false, lastUpdate: 0, expiry: setTimeout(stopDrag, 30_000) };
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
    moveDraggedPet(cursor);
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
  function audioAllowed(contents, permission, details = {}) {
    return permission === 'media' && Date.now() < voiceAllowedUntil && isAlive(companionWindow)
      && contents === companionWindow.webContents && contents.getURL() === COMPANION_URL
      && details.mediaType !== 'video'
      && (!details.mediaTypes || (details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'));
  }
  target.setPermissionRequestHandler((contents, permission, callback, details) => callback(audioAllowed(contents, permission, details)));
  target.setPermissionCheckHandler((contents, permission, _origin, details) => audioAllowed(contents, permission, details));
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
    if (extension === '.html' && !['/src/pet.html', '/src/settings.html', '/src/companion.html'].includes(pathname)) return new Response(null, { status: 403 });
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
  const bounds = fittedPetBounds(preferences.position);
  petWindow = new BrowserWindow({
    ...bounds,
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
    if (!dock) applyFreePetBounds(fittedPetBounds(petWindow.getBounds()));
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
  if (quitting || pauses.has('locked') || pauses.has('suspended')) return;
  if (pauses.has('fullscreen')) {
    disableFullscreenAutoHide(); savePreferences(); updateTrayMenu(); publishState();
  }
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

function openDeepLink(value){
  const target=parseDeepLink(value);if(!target)return false;
  if(!petWindow||!companionHost){pendingDeepLink=value;return true;}
  if(pauses.has('locked')||pauses.has('suspended')||quitting)return true;
  restorePet();if(target==='companion')showCompanion();return true;
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event,argv=[])=>{const link=argv.find(value=>typeof value==='string'&&value.startsWith(DEEP_LINK_SCHEME+':'));if(link)openDeepLink(link);else restorePet();});
  app.on('open-url',(event,value)=>{event.preventDefault();openDeepLink(value);});
  app.on('activate', restorePet);
  app.on('before-quit', () => {
    quitting = true;
    companionHost?.stop();
    clearTimeout(movementTimer); movementTimer = null;
    stopDrag();
    clearTimeout(positionSaveTimer);
    clearInterval(desktopTimer); desktopTimer = null;
    stopFullscreenMonitor();
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
    if (!fullscreenAvailable) preferences.settings.autoHideFullscreen = false;
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
    shortcutStore = createShortcutStore({directory:app.getPath('userData'),openPath:value=>shell.openPath(value)});
    shortcutStore.load();
    characterStore=createCharacterStore(app.getPath('userData'),{validateImage:validateCharacterImage});characterReady=characterStore.load();
    companionHost = createCompanionHost({directory: app.getPath('userData'), safeStorage, openLink,
      emit: emitCompanionEvent,
      publish(value) {
        if (isAlive(companionWindow) && companionWindow.isVisible()) companionWindow.webContents.send('andromeda:companion', value);
        if (value.companion) {
          const current = companionHost?.publicState();
          // Compare only the tiny public projection, never serialize private collections.
          const changed = !lastPublicState || current.mood !== lastPublicState.mood || current.focusing !== lastPublicState.focusing
            || current.level !== lastPublicState.level || current.routine.period !== lastPublicState.routine.period
            || current.routine.season !== lastPublicState.routine.season
            || Object.keys(current.preferences).some(key => current.preferences[key] !== lastPublicState.preferences[key]);
          if (changed) {
            lastPublicState = current;
            if (isAlive(petWindow) && petWindow.isVisible() && !paused()) petWindow.webContents.send('andromeda:public', current);
            updateMovement();
          }
        }
      },
      capture: async ({signal} = {}) => {
        if (signal?.aborted || quitting || pauses.has('locked') || pauses.has('suspended')) throw new Error('截图已取消');
        const display = screen.getDisplayMatching(normalBounds());
        const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: {width: 1280, height: 720}, fetchWindowIcons: false});
        if (signal?.aborted || quitting || pauses.has('locked') || pauses.has('suspended')) throw new Error('截图已取消');
        const source = sources.find(item => item.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty()) throw new Error('当前屏幕无法预览');
        return source.thumbnail.toDataURL();
      },
    });
    companionHost.ready.catch(() => { if (isAlive(companionWindow)) companionWindow.webContents.send('andromeda:companion', {persistenceError: '陪伴模块未能启动，请重新打开应用。'}); });
    const startupLink=pendingDeepLink||process.argv?.find(value=>value.startsWith(DEEP_LINK_SCHEME+':'));
    pendingDeepLink=null;if(startupLink)openDeepLink(startupLink);
    function pausePrivateCompanion() {
      voiceAllowedUntil = 0; companionHost?.pause();
      if(isAlive(petWindow))petWindow.webContents.send('andromeda:rhythm',0);
      if (isAlive(companionWindow)) {companionWindow.webContents.send('andromeda:companion',{hostPaused:true});companionWindow.hide();}
    }
    powerMonitor.on('lock-screen', pausePrivateCompanion);
    powerMonitor.on('suspend', pausePrivateCompanion);
    if (!hasTray()) preferences.settings.autoHideFullscreen = false;
    updateFullscreenMonitor();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(eventName, () => {
        stopDrag(); if (dock) dock.hideAt = null; clampPetPosition();
        // Discard the old physical topology until the next native heartbeat.
        applyFullscreenSnapshot(null);
      });
    }
  }).catch((error) => {
    console.error('Unable to start Andromeda:', error);
    dialog.showErrorBox(APP_NAME, '启动失败。请检查应用文件完整性以及用户配置文件夹权限。');
    quitting = true;
    app.quit();
  });
}
