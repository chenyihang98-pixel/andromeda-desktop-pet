'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { buildWindowsHelper, compilerCandidates } = require('../scripts/build-windows-helper.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

test('helper builds reject unsupported hosts and targets instead of reusing binaries', () => {
  assert.throws(() => buildWindowsHelper({ platform: 'linux' }), /cross-builds are not supported/);
  assert.throws(() => buildWindowsHelper({ platform: 'win32', arch: 'arm64' }), /x64 builds only/);
  assert.throws(() => buildWindowsHelper({ platform: 'win32', exists: () => false }), /compiler.*unavailable/);
  assert.deepEqual(compilerCandidates('C:\\Windows'), [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ]);
});

test('pack hook leaves other platforms alone and rejects incompatible Windows architectures', async () => {
  const beforePack = require('../scripts/before-pack.cjs');
  await beforePack({ electronPlatformName: 'linux', arch: 1 });
  await assert.rejects(beforePack({ electronPlatformName: 'win32', arch: 3 }), /x64 only/);
});

test('failed compiler invocation cannot leave a stale generated helper for packaging', () => {
  fs.mkdirSync(DIST, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(DIST, 'windows-helper-test-'));
  const executable = path.join(temporary, 'windows-fullscreen.exe');
  try {
    fs.writeFileSync(executable, 'stale generated output');
    let invoked = false;
    assert.throws(() => buildWindowsHelper({ outputDirectory: temporary, platform: 'win32',
      exists: value => value.endsWith('csc.exe') || fs.existsSync(value),
      run: (_compiler, args, options) => {
        invoked = true;
        assert.equal(fs.existsSync(executable), false);
        assert.ok(args.includes('/platform:x64'));
        assert.ok(args.includes('/noconfig'));
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        fs.writeFileSync(executable, 'partial compiler output');
        return { status: 1, stdout: 'fixture compilation error' };
      },
    }), /compilation failed/);
    assert.equal(invoked, true);
    assert.equal(fs.existsSync(executable), false);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), DIST);
    assert.ok(path.basename(temporary).startsWith('windows-helper-test-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Windows helper compiles and passes pure policy fixtures; parent/pipe shutdown is bounded',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    fs.mkdirSync(DIST, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(DIST, 'windows-helper-test-'));
    const children = new Set();
    t.after(() => {
      for (const child of children) child.kill();
      // Only remove this test's newly created directory inside the project.
      assert.equal(path.dirname(path.resolve(temporary)), DIST);
      assert.ok(path.basename(temporary).startsWith('windows-helper-test-'));
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const executable = buildWindowsHelper({ outputDirectory: temporary });
    const fixtures = spawnSync(executable, ['--self-test'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(fixtures.status, 0, fixtures.stderr);
    const result = JSON.parse(fixtures.stdout.trim());
    assert.equal(result.version, 1);
    assert.equal(result.selfTest, true);
    assert.ok(result.passed >= 30);

    // Invalid arguments and absent parents exit without querying desktop state.
    for (const args of [[], ['--parent-pid', '0'], ['--parent-pid', '1;invalid']]) {
      const invalid = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      assert.equal(invalid.status, 2);
      assert.equal(invalid.stdout, '');
    }
    const absent = spawnSync(executable, ['--parent-pid', '2147483647'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(absent.status, 0);
    assert.equal(absent.stdout, '');

    // Observe three real metadata heartbeats before closing stdin. This exercises
    // native API availability and lifecycle, not positive fullscreen detection.
    // No user input, foreground change, screenshot, or probe window is created.
    const child = spawn(executable, ['--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    children.add(child);
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Helper did not exit after stdin EOF')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); children.delete(child); resolve(code); });
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.split('\n').length - 1 >= 3) child.stdin.end();
    });
    assert.equal(await completion, 0);
    assert.equal(stderr, '');
    const heartbeats = stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.ok(heartbeats.length >= 3);
    for (const line of heartbeats) {
      const sample = JSON.parse(line);
      assert.equal(sample.version, 1);
      assert.equal(typeof sample.fullscreen, 'boolean');
      assert.deepEqual(Object.keys(sample).sort(), sample.fullscreen ? ['fullscreen', 'monitor', 'version'] : ['fullscreen', 'version']);
      if (sample.fullscreen) {
        assert.deepEqual(Object.keys(sample.monitor).sort(), ['height', 'width', 'x', 'y']);
        for (const value of Object.values(sample.monitor)) assert.ok(Number.isInteger(value));
        assert.ok(sample.monitor.width > 0 && sample.monitor.height > 0);
      }
    }
  });
