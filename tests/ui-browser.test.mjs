import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findChromium} from '../scripts/ui-browser.mjs';

test('explicit browser path takes precedence and must be a file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'andromeda-ui-browser-'));
  const executable = join(directory, 'custom browser.exe');
  writeFileSync(executable, 'test fixture');
  t.after(() => { unlinkSync(executable); rmdirSync(directory); });
  assert.equal(findChromium({env: {CHROMIUM_PATH: executable}}), executable);
  for (const path of [directory, join(directory, 'missing.exe')]) {
    assert.throws(() => findChromium({env: {CHROMIUM_PATH: path}}), /CHROMIUM_PATH is not a browser executable file/);
  }
});

test('Windows browser discovery supports machine and per-user installations', () => {
  const env = {ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local'};
  for (const executable of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\Tester\\AppData\\Local\\Chromium\\Application\\chrome.exe',
  ]) {
    assert.equal(findChromium({platform: 'win32', env, fileExists: candidate => candidate === executable}), executable);
  }
});

test('missing browser gives a path override and does not download or disable security', () => {
  assert.throws(() => findChromium({platform: 'win32', env: {}, fileExists: () => false}),
    /Set CHROMIUM_PATH.*sandbox protections must remain enabled/);
});
