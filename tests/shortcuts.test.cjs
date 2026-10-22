'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createShortcutStore, localApplicationPath, MAX_SHORTCUTS } = require('../src/services/shortcuts.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-shortcuts-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('andromeda-shortcuts-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const opened = [];
  const openPath = async file => { opened.push(file); return ''; };
  const store = createShortcutStore({ directory, openPath, ...options });
  const appFile = (name = 'my application.exe') => {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, 'not executable; test fixture only');
    return filename;
  };
  return { directory, store, opened, openPath, appFile };
}

test('only canonical local Windows application paths are accepted', () => {
  for (const value of ['C:\\Program Files\\App\\app.EXE', 'D:/Apps/my app.lnk']) {
    assert.equal(localApplicationPath(value), path.win32.normalize(value));
  }
  for (const value of ['app.exe', 'C:app.exe', '/usr/bin/app', '\\\\server\\share\\app.exe', '\\\\?\\C:\\app.exe',
    'file:///C:/app.exe', 'https://host/app.exe', 'C:\\app.cmd', 'C:\\app.ps1', 'C:\\app.exe --flag',
    'C:\\app.exe:payload', 'C:\\dir\\..\\app.exe', 'C:\\dir\\.\\app.exe', 'C:\\app.exe\u0000',
    'C:\\app\n.exe', 'C:\\name \\app.exe', 'C:\\CON.exe', 'C:\\nul\\app.exe', 'C:\\a?\\app.exe',
    'C:\\' + 'x'.repeat(1024) + '.exe', null, {}]) {
    assert.throws(() => localApplicationPath(value), error => error.code === 'INVALID_PATH' && !error.message.includes(String(value)));
  }
});

// File-backed tests only use dummy files and an injected opener; they never execute an application.
const windowsTest = process.platform === 'win32' ? test : test.skip;

windowsTest('add/list/load expose metadata only, persist private paths, and never launch automatically', t => {
  const { directory, store, opened, openPath, appFile } = fixture(t);
  assert.deepEqual(store.load(), []);
  const applicationPath = appFile('my application.exe');
  const entry = store.add({ name: ' My Application ', path: applicationPath });
  assert.equal(entry.name, 'My Application');
  assert.deepEqual(Object.keys(entry), ['id', 'name']);
  assert.deepEqual(store.list(), [entry]);
  const copy = store.list(); copy[0].name = 'tampered'; copy.push({ id: 'bad' });
  assert.deepEqual(store.list(), [entry]);
  assert.deepEqual(opened, []);
  const raw = fs.readFileSync(path.join(directory, 'shortcuts.json'), 'utf8');
  assert.equal(JSON.parse(raw).shortcuts[0].path, applicationPath);
  const restored = createShortcutStore({ directory, openPath });
  assert.deepEqual(restored.load(), [entry]);
  assert.equal(JSON.stringify(restored.list()).includes(applicationPath), false);
  assert.deepEqual(opened, []);
});

windowsTest('launch opens only stored IDs with exactly one path argument; remove revokes future launches', async t => {
  const { store, opened, appFile } = fixture(t);
  const filename = appFile('owner selected.lnk');
  const entry = store.add({ name: 'Owner selected', path: filename });
  await assert.rejects(store.launch(filename), { code: 'INVALID_INPUT' });
  await assert.rejects(store.launch(randomUUID()), { code: 'NOT_FOUND' });
  assert.deepEqual(opened, []);
  assert.equal(await store.launch(entry.id), true);
  assert.deepEqual(opened, [filename]);
  assert.equal(store.remove(entry.id), true);
  assert.equal(store.remove(entry.id), false);
  await assert.rejects(store.launch(entry.id), { code: 'NOT_FOUND' });
  assert.deepEqual(store.list(), []);
  assert.deepEqual(opened, [filename]);
});

windowsTest('directories, missing files, URLs, unknown fields and invalid labels never enter the whitelist', t => {
  const { directory, store, appFile } = fixture(t);
  const filename = appFile();
  const fakeDirectory = path.join(directory, 'directory.exe');
  fs.mkdirSync(fakeDirectory);
  for (const input of [{ name: 'Directory', path: fakeDirectory }, { name: 'Missing', path: path.join(directory, 'missing.exe') },
    { name: 'URL', path: 'https://example.com/app.exe' }, { name: '', path: filename },
    { name: 'x'.repeat(81), path: filename }, { name: 'bad\nname', path: filename },
    { name: 'App', path: filename, args: '--run-command' }, null, [],
    Object.defineProperty({path: filename}, 'name', { get() { throw new Error('getter must not run'); } })]) {
    assert.throws(() => store.add(input), error => error.name === 'ShortcutError' && !error.message.includes(filename));
  }
  assert.deepEqual(store.list(), []);
});

windowsTest('duplicate paths, including case variants, and capacity overflow are rejected atomically', t => {
  const { store, appFile } = fixture(t);
  const filename = appFile();
  store.add({ name: 'First', path: filename });
  assert.throws(() => store.add({ name: 'Again', path: filename.toUpperCase() }), { code: 'DUPLICATE' });
  for (let index = 1; index < MAX_SHORTCUTS; index++) store.add({ name: `App ${index}`, path: appFile(`app-${index}.exe`) });
  assert.equal(store.list().length, MAX_SHORTCUTS);
  assert.throws(() => store.add({ name: 'Overflow', path: appFile('overflow.exe') }), { code: 'LIMIT' });
  assert.equal(store.list().length, MAX_SHORTCUTS);
});

windowsTest('deleted or directory-replaced applications fail safely and are not passed to the opener', async t => {
  const { directory, store, openPath, opened, appFile } = fixture(t);
  const filename = appFile();
  const entry = store.add({ name: 'App', path: filename });
  fs.unlinkSync(filename);
  const restored = createShortcutStore({ directory, openPath });
  assert.deepEqual(restored.load(), [entry], 'Missing applications remain visible for removal');
  await assert.rejects(restored.launch(entry.id), { code: 'LAUNCH_FAILED' });
  fs.mkdirSync(filename);
  await assert.rejects(restored.launch(entry.id), { code: 'LAUNCH_FAILED' });
  assert.deepEqual(opened, []);
});

windowsTest('injected opener error strings and thrown errors never leak private paths', async t => {
  for (const kind of ['returns-error', 'throws']) {
    const { store, appFile } = fixture(t, { openPath: async file => {
      if (kind === 'throws') throw new Error(`private path ${file}`);
      return `private path ${file}`;
    } });
    const filename = appFile();
    const entry = store.add({ name: 'App', path: filename });
    await assert.rejects(store.launch(entry.id), error => error.code === 'LAUNCH_FAILED' && !error.message.includes(filename));
  }
});

windowsTest('failed atomic save preserves the previous in-memory list and does not leave temporary files', t => {
  const { directory, store, appFile } = fixture(t);
  const first = store.add({ name: 'First', path: appFile('first.exe') });
  const persisted = path.join(directory, 'shortcuts.json');
  fs.unlinkSync(persisted);
  fs.mkdirSync(persisted); // Force rename to fail without monkey-patching global filesystem APIs.
  assert.throws(() => store.add({ name: 'Second', path: appFile('second.exe') }), { code: 'SAVE_FAILED' });
  assert.deepEqual(store.list(), [first]);
  assert.throws(() => store.remove(first.id), { code: 'SAVE_FAILED' });
  assert.deepEqual(store.list(), [first]);
  assert.equal(fs.readdirSync(directory).some(file => file.startsWith('.shortcuts-')), false);
});

windowsTest('malformed/oversized/tampered storage fails closed and never executes or rewrites it', t => {
  const { directory, store, opened, appFile } = fixture(t);
  const filename = appFile();
  const entry = { id: randomUUID(), name: 'App', path: filename };
  const serialized = [
    '{', 'x'.repeat(128 * 1024 + 1),
    JSON.stringify({version: 2, shortcuts: [entry]}),
    JSON.stringify({version: 1, shortcuts: [{...entry, path: 'https://attacker.example/app.exe'}]}),
    JSON.stringify({version: 1, shortcuts: [{...entry, args: 'run-anything'}]}),
    JSON.stringify({version: 1, shortcuts: [entry, {...entry}]}),
    JSON.stringify({version: 1, shortcuts: Array.from({length: MAX_SHORTCUTS + 1}, () => entry)}),
  ];
  for (const source of serialized) {
    fs.writeFileSync(path.join(directory, 'shortcuts.json'), source);
    assert.deepEqual(store.load(), []);
    assert.equal(fs.readFileSync(path.join(directory, 'shortcuts.json'), 'utf8'), source);
  }
  assert.deepEqual(opened, []);
});

windowsTest('an injected failed existence probe denies both add and launch without opening a file', async t => {
  let available = true;
  const { store, opened, appFile } = fixture(t, { existsSync: () => available });
  const filename = appFile();
  const entry = store.add({ name: 'App', path: filename });
  available = false;
  await assert.rejects(store.launch(entry.id), { code: 'LAUNCH_FAILED' });
  assert.throws(() => store.add({name: 'Another', path: appFile('other.exe')}), {code: 'INVALID_PATH'});
  assert.deepEqual(opened, []);
});
