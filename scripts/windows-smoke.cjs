'use strict';

// Run: .\node_modules\.bin\electron.cmd scripts/windows-smoke.cjs
// This exercises native window geometry only, not pet input, tray, power
// events, focus behavior, or the complete packaged-application QA matrix.
if (!process.versions.electron || process.platform !== 'win32') {
  console.error('Run this Windows-only probe with the local Electron executable.');
  process.exit(1);
}

const { app, BrowserWindow, screen, session } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { dockBounds } = require('../src/docking.cjs');
const { applyDockWindowBounds } = require('../src/dock-window.cjs');
const { DEFAULT_SETTINGS, petSize } = require('../src/settings.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'qa', 'windows-smoke.json');
const profile = path.join(root, 'qa', `windows-smoke-profile-${process.pid}`);
const report = {
  schemaVersion: 1,
  scope: 'native-window-geometry-only',
  limitations: [
    'Standalone local Electron probe; not a packaged Andromeda application test.',
    'Only the attached displays and their current work areas/DPI are exercised.',
    'No mouse routing, capture, tray, focus, lock/sleep, RDP, or monitor-disconnection verification.',
  ],
  startedAt: new Date().toISOString(),
  status: 'running',
  environment: {
    platform: process.platform, architecture: process.arch,
    osRelease: os.release(), osVersion: os.version(),
    electron: process.versions.electron, chromium: process.versions.chrome,
    node: process.versions.node,
  },
  profileDirectory: path.relative(root, profile),
  displays: [], checks: [],
};
let window;
let finished = false;
let deadline;

function finish(error = null) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const passed = !error && report.checks.length > 0 && report.checks.every(check => check.passed);
  report.status = passed ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();
  if (error) report.error = error.message || String(error);
  if (window && !window.isDestroyed()) window.destroy();
  let exitCode = passed ? 0 : 1;
  try {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length,
      passed: report.checks.filter(check => check.passed).length, report: output }));
  } catch (writeError) {
    exitCode = 1;
    console.error('Could not write geometry report:', writeError.message);
  }
  // Explicitly destroy the probe window and terminate its Electron subprocesses
  // even when native setup, renderer launch, or a geometry check failed.
  app.exit(exitCode);
}

function blockSession(target) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  target.on('will-download', event => event.preventDefault());
}

const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const sameBounds = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const within = (bounds, area) => bounds.x >= area.x && bounds.y >= area.y
  && bounds.x + bounds.width <= area.x + area.width
  && bounds.y + bounds.height <= area.y + area.height;

async function checkBounds(display, edge, phase, size) {
  const result = applyDockWindowBounds(window,
    { displayId: display.id, edge, ratio: 0.5, collapsed: phase === 'collapsed' }, size, screen.getAllDisplays());
  if (!result) throw new Error(`Native ${edge} ${phase} geometry cannot fit display ${display.id}.`);
  await settle();
  const first = window.getBounds();
  await settle();
  const actual = window.getBounds();
  const stable = sameBounds(first, actual);
  const contained = within(actual, display.workArea);
  report.checks.push({ displayId: display.id, edge, phase,
    requested: result.requested, measuredBeforePositionCorrection: result.measured,
    expected: result.expected, actual, exactRequestedSize: actual.width === result.requested.width && actual.height === result.requested.height,
    stable, withinWorkArea: contained, passed: stable && contained && sameBounds(result.expected, actual) });
}

process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

try {
  app.setName('Andromeda Windows Geometry Smoke');
  app.enableSandbox();
  // Override every profile/cache/log path before ready. The real Andromeda
  // profile and other applications' profiles are never loaded or edited.
  for (const name of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) {
    const directory = path.join(profile, name);
    mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  report.source = {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    workingTreeDirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
    sha256: Object.fromEntries(['scripts/windows-smoke.cjs', 'src/main.cjs', 'src/dock-window.cjs', 'src/docking.cjs', 'src/settings.cjs']
      .map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
  };
  deadline = setTimeout(() => finish(new Error('Native geometry probe exceeded 60 seconds.')), 60_000);
  app.whenReady().then(async () => {
    blockSession(session.defaultSession);
    const probeSession = session.fromPartition('andromeda-windows-smoke', { cache: false });
    blockSession(probeSession);
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error('No display is available.');
    const primaryId = screen.getPrimaryDisplay().id;
    report.displays = displays.map(display => ({ id: display.id, primary: display.id === primaryId,
      bounds: display.bounds, workArea: display.workArea,
      scaleFactor: display.scaleFactor, rotation: display.rotation }));
    const size = petSize(DEFAULT_SETTINGS.scale);
    const initial = dockBounds({ displayId: displays[0].id, edge: 'left', ratio: 0.5 }, size, displays);
    if (!initial) throw new Error('The display work area cannot form a valid dock.');
    const options = {
      ...initial.expanded,
      title: 'Andromeda native geometry probe',
      transparent: true, backgroundColor: '#00000000', frame: false,
      hasShadow: false, resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      webPreferences: { session: probeSession, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false },
    };
    report.windowOptions = { transparent: true, frame: false, hasShadow: false,
      resizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      mouseInputIgnored: true, applicationScale: DEFAULT_SETTINGS.scale };
    window = new BrowserWindow(options);
    report.minimumSize = window.getMinimumSize();
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      window.webContents.on(name, event => event.preventDefault());
    }
    window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Probe renderer stopped: ${details.reason}`)));
    // No page is loaded and no screen contents are captured. Ignoring input
    // keeps these transient geometry rectangles from intercepting user clicks.
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    for (const display of displays) {
      for (const edge of ['left', 'right', 'top', 'bottom']) {
        await checkBounds(display, edge, 'expanded', size);
        await checkBounds(display, edge, 'collapsed', size);
        await checkBounds(display, edge, 'restored', size);
      }
    }
    finish();
  }).catch(finish);
} catch (error) {
  finish(error);
}
