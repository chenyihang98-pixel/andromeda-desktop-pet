'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_SHORTCUTS = 32;
const MAX_FILE_BYTES = 128 * 1024;
const ERRORS = Object.freeze({
  INVALID_INPUT: '快捷入口参数无效。',
  INVALID_NAME: '应用名称不能为空，且最多80个字符。',
  INVALID_PATH: '请选择本机磁盘上的 .exe 应用或 .lnk 快捷方式文件。',
  NOT_FOUND: '这个应用快捷入口不存在，请重新选择。',
  DUPLICATE: '这个应用已经在快捷入口中。',
  LIMIT: '快捷入口最多保存32项，请先移除不再使用的入口。',
  SAVE_FAILED: '应用快捷入口保存失败，原有列表未改变。',
  LAUNCH_FAILED: '无法打开这个应用，请检查文件是否仍然可用。',
});

function fail(code) {
  const error = new Error(ERRORS[code]);
  error.name = 'ShortcutError';
  error.code = code;
  return error;
}

function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, 'value')))
    throw fail('INVALID_INPUT');
  return value;
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value))
    throw fail('INVALID_NAME');
  return value.trim();
}

function idValue(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
    throw fail('INVALID_INPUT');
  return value;
}

/** The host must supply a native file-picker result, never a renderer/model-provided path. */
function localApplicationPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[a-z]:[\\/]/iu.test(value)
    || /[\u0000-\u001f\u007f<>"|?*]/u.test(value) || !path.win32.isAbsolute(value)) throw fail('INVALID_PATH');
  const parts = value.slice(3).split(/[\\/]/u);
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes(':')
    || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw fail('INVALID_PATH');
  const result = path.win32.normalize(value);
  if (!['.exe', '.lnk'].includes(path.win32.extname(result).toLowerCase())) throw fail('INVALID_PATH');
  return result;
}

function createShortcutStore({ directory, openPath, existsSync = fs.existsSync } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof openPath !== 'function'
    || typeof existsSync !== 'function') throw fail('INVALID_INPUT');
  const filename = path.join(directory, 'shortcuts.json');
  let entries = [];
  const keyOf = value => value.toLowerCase();
  const publicEntry = entry => ({ id: entry.id, name: entry.name });

  function list() { return entries.map(publicEntry); }

  function fileAvailable(filename) {
    try { return existsSync(filename) === true && fs.statSync(filename).isFile(); }
    catch { return false; }
  }

  function save(next) {
    const temp = path.join(directory, `.shortcuts-${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, shortcuts: next }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, filename);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* No private paths or raw filesystem errors leave the store. */ }
      throw fail('SAVE_FAILED');
    }
    entries = next;
  }

  function load() {
    try {
      if (fs.statSync(filename).size > MAX_FILE_BYTES) throw fail('INVALID_INPUT');
      const saved = record(JSON.parse(fs.readFileSync(filename, 'utf8')), ['version', 'shortcuts']);
      if (saved.version !== 1 || !Array.isArray(saved.shortcuts) || saved.shortcuts.length > MAX_SHORTCUTS)
        throw fail('INVALID_INPUT');
      const ids = new Set(), paths = new Set();
      const next = saved.shortcuts.map(item => {
        record(item, ['id', 'name', 'path']);
        const entry = { id: idValue(item.id), name: nameValue(item.name), path: localApplicationPath(item.path) };
        if (ids.has(entry.id) || paths.has(keyOf(entry.path))) throw fail('INVALID_INPUT');
        ids.add(entry.id); paths.add(keyOf(entry.path));
        return entry;
      });
      // A temporarily missing application stays removable; launch checks the file again.
      entries = next;
    } catch { entries = []; }
    return list();
  }

  function add(input) {
    record(input, ['name', 'path']);
    const name = nameValue(input.name), applicationPath = localApplicationPath(input.path);
    if (!fileAvailable(applicationPath)) throw fail('INVALID_PATH');
    if (entries.some(entry => keyOf(entry.path) === keyOf(applicationPath))) throw fail('DUPLICATE');
    if (entries.length >= MAX_SHORTCUTS) throw fail('LIMIT');
    const entry = { id: randomUUID(), name, path: applicationPath };
    save([...entries, entry]);
    return publicEntry(entry);
  }

  function remove(id) {
    idValue(id);
    if (!entries.some(entry => entry.id === id)) return false;
    save(entries.filter(entry => entry.id !== id));
    return true;
  }

  async function launch(id) {
    idValue(id);
    const entry = entries.find(item => item.id === id);
    if (!entry) throw fail('NOT_FOUND');
    if (!fileAvailable(entry.path)) throw fail('LAUNCH_FAILED');
    try {
      // shell.openPath receives exactly the saved native path; never a shell command or arguments.
      const error = await openPath(entry.path);
      if (error !== '') throw fail('LAUNCH_FAILED');
      return true;
    } catch { throw fail('LAUNCH_FAILED'); }
  }

  return Object.freeze({ load, list, add, remove, launch });
}

module.exports = { createShortcutStore, localApplicationPath, MAX_SHORTCUTS };
