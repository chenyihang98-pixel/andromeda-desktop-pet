'use strict';

// Explicit native integration probe: briefly opens its own normal, maximized,
// and fullscreen window. It never sends mouse/keyboard input to another app.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'qa', 'fullscreen-smoke.json');

if (process.platform !== 'win32') throw new Error('This native probe requires Windows.');

if (process.versions.electron && process.argv.includes('--fixture')) {
  const { app, BrowserWindow, screen, session } = require('electron');
  const profile = path.join(ROOT, 'qa', `fullscreen-fixture-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  for (const name of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.setName('Andromeda fullscreen validation');
  app.enableSandbox();
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  let window;
  const deadline = setTimeout(() => app.exit(1), 45_000);
  const ready = app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((_details, reply) => reply({ cancel: true }));
    session.defaultSession.on('will-download', event => event.preventDefault());
    window = new BrowserWindow({
      width: 640, height: 480, show: false, backgroundColor: '#182238',
      title: 'Andromeda fullscreen test — closes automatically',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
  });
  ready.then(async () => {
    window.show(); window.focus();
    // Windows Electron GUI processes do not reliably inherit piped stdin.
    // Run a bounded sequence autonomously; stdout supplies only stage metadata.
    for (const command of ['normal', 'maximized', 'fullscreen', 'restored']) {
      if (command === 'fullscreen') window.setFullScreen(true);
      else {
        window.setFullScreen(false);
        if (command === 'maximized') window.maximize();
        else { window.unmaximize(); window.setBounds({ x: 100, y: 100, width: 640, height: 480 }); }
      }
      window.focus();
      await new Promise(resolve => setTimeout(resolve, 1200));
      const display = screen.getDisplayMatching(window.getBounds());
      const result = {
        command, focused: window.isFocused(), fullscreen: window.isFullScreen(), maximized: window.isMaximized(), bounds: window.getBounds(),
        monitor: screen.dipToScreenRect(window, display.bounds), scaleFactor: display.scaleFactor,
      };
      process.stdout.write('SMOKE ' + JSON.stringify(result) + '\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { spawn, execFileSync } = require('node:child_process');
  const { createFullscreenMonitor } = require('../src/fullscreen-monitor.cjs');
  const { buildWindowsHelper } = require('./build-windows-helper.cjs');
  const helper = buildWindowsHelper();
  const checks = [];
  let fixture, fixtureClosed, detector, pending, failure, observations = [], serial = 0;
  const report = {
    timestamp: new Date().toISOString(), sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
    platform: process.platform, architecture: process.arch, osRelease: require('node:os').release(),
    helperSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    scope: 'Controlled Electron fixture only; no game, video-player, real mouse, mixed-DPI, lock/suspend, RDP or UAC acceptance.',
    checks,
  };
  async function run() {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    const executable = require('electron');
    fixture = spawn(executable, [__filename, '--fixture'], { cwd: ROOT, windowsHide: false, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    fixtureClosed = new Promise(resolve => fixture.once('close', resolve));
    const diagnostic = fs.createWriteStream(path.join(ROOT, 'qa', 'fullscreen-fixture.log'));
    diagnostic.on('error', () => { failure = new Error('Fixture diagnostic log is unavailable'); });
    fixture.stderr.pipe(diagnostic);
    fixture.once('error', () => { failure = new Error('Fixture failed to start'); });
    fixture.once('close', () => { if (pending) { pending.reject(new Error('Fixture exited early')); pending = null; } });
    require('node:readline').createInterface({ input: fixture.stdout }).on('line', line => {
      if (!line.startsWith('SMOKE ') || !pending) return;
      try { const result = JSON.parse(line.slice(6)); const request = pending; pending = null; request.resolve(result); }
      catch { pending.reject(new Error('Invalid fixture output')); pending = null; }
    });
    detector = createFullscreenMonitor({ helperPath: helper,
      onChange: monitor => { observations.push({ serial: ++serial, monitor }); },
      onError: reason => { failure = new Error('Detector failed: ' + reason); },
    });
    detector.start();
    for (const command of ['normal', 'maximized', 'fullscreen', 'restored']) {
      observations = [];
      const state = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(new Error('Fixture response timed out')); }, 8000);
        pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
      // Use two fresh detector samples after the fixture has settled.
      const settled = serial;
      for (let attempt = 0; observations.filter(item => item.serial > settled).length < 2 && attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (failure) throw failure;
      const samples = observations.filter(item => item.serial > settled);
      const expected = command === 'fullscreen';
      const passed = state.command === command && state.focused && state.fullscreen === expected
        && state.maximized === (command === 'maximized') && samples.length >= 2
        && samples.every(item => expected ? JSON.stringify(item.monitor) === JSON.stringify(state.monitor) : item.monitor === null);
      checks.push({ state: command, focused: state.focused, scaleFactor: state.scaleFactor,
        dipBounds: state.bounds,
        nativeFullscreen: state.fullscreen, nativeMaximized: state.maximized,
        physicalMonitor: state.monitor, samples: samples.length, detectedFullscreen: samples.map(item => Boolean(item.monitor)), passed });
      if (!passed) throw new Error('Native fixture check failed: ' + command);
    }
    report.passed = true;
  }
  run().catch(error => { report.passed = false; report.error = error.message; process.exitCode = 1; }).finally(async () => {
    detector?.stop();
    if (fixture && fixture.exitCode === null) {
      const timeout = setTimeout(() => fixture.kill(), report.passed ? 6500 : 2500);
      let deadline;
      await Promise.race([fixtureClosed, new Promise(resolve => { deadline = setTimeout(resolve, report.passed ? 8000 : 4000); })]);
      clearTimeout(timeout); clearTimeout(deadline);
    }
    report.fixtureExited = Boolean(fixture && (fixture.exitCode !== null || fixture.signalCode !== null));
    if (!report.fixtureExited) { report.passed = false; process.exitCode = 1; }
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(`Fullscreen native fixture: ${checks.filter(item => item.passed).length}/${checks.length}; ${path.relative(ROOT, REPORT)}`);
  });
}
