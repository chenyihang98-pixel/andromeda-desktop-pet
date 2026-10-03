'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SETTINGS, sanitizeSettings, validateSettingsPatch, sanitizePosition,
  sanitizeRecord, petSize, clampPosition, defaultPosition, createSettingsStore,
} = require('../src/settings.cjs');

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const left = { workArea: { x: -1280, y: 0, width: 1280, height: 984 } };

test('default settings are quiet, medium sized, with no cursor gaze', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { scale: 1.25, motion: 'quiet', gaze: false, alwaysOnTop: true, edgeDock: true, globalGaze: false, clickThrough: false });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});

test('stored settings sanitize invalid fields without carrying unknown keys', () => {
  assert.deepEqual(sanitizeSettings({ scale: '2', motion: 'walk', gaze: 1, alwaysOnTop: null, hidden: true }), DEFAULT_SETTINGS);
  assert.equal(sanitizeSettings({ scale: 100 }).scale, 2);
  assert.equal(sanitizeSettings({ scale: -1 }).scale, 0.75);
  assert.equal(sanitizeSettings({ scale: NaN }).scale, 1.25);
  assert.equal(sanitizeSettings({ scale: Infinity }).scale, 1.25);
  assert.deepEqual(sanitizeSettings({ scale: 1.456, motion: 'still', gaze: true, alwaysOnTop: false }), {
    ...DEFAULT_SETTINGS, scale: 1.46, motion: 'still', gaze: true, alwaysOnTop: false,
  });
});

test('all legal setting patches are copied, normalized, and accepted', () => {
  const input = { scale: 0.75, motion: 'lively', gaze: true, alwaysOnTop: false };
  assert.deepEqual(validateSettingsPatch(input), input);
  assert.notEqual(validateSettingsPatch(input), input);
  assert.deepEqual(validateSettingsPatch({ scale: 2 }), { scale: 2 });
  assert.deepEqual(validateSettingsPatch({ scale: 1.456 }), { scale: 1.46 });
  for (const motion of ['quiet', 'still', 'lively']) assert.deepEqual(validateSettingsPatch({ motion }), { motion });
});

test('malformed or unknown patches are rejected as a whole', () => {
  for (const input of [
    null, [], 'quiet', 42, {}, { hidden: true }, { position: { x: 0, y: 0 } },
    { scale: 0.749 }, { scale: 2.001 }, { scale: '1.25' }, { scale: NaN }, { scale: Infinity },
    { motion: 'walk' }, { gaze: 'true' }, { alwaysOnTop: 1 },
    { scale: 1, unknown: true }, Object.create({ scale: 1 }),
    JSON.parse('{"__proto__":{"gaze":true}}'),
  ]) assert.throws(() => validateSettingsPatch(input), TypeError);
});

test('null prototype patches are safe, and source values are not mutated', () => {
  const input = Object.assign(Object.create(null), { scale: 1.456 });
  assert.deepEqual(validateSettingsPatch(input), { scale: 1.46 });
  assert.equal(input.scale, 1.456);
});

test('positions require finite numeric coordinates and are rounded', () => {
  assert.deepEqual(sanitizePosition({ x: -500.2, y: 42.7 }), { x: -500, y: 43 });
  for (const input of [null, [], {}, { x: '1', y: 2 }, { x: Infinity, y: 0 }, { x: 0, y: NaN }, { x: 1e20, y: 0 }]) {
    assert.equal(sanitizePosition(input), null);
  }
});

test('records ignore unsupported versions and never persist visibility', () => {
  const defaults = { version: 1, settings: { ...DEFAULT_SETTINGS }, position: null };
  assert.deepEqual(sanitizeRecord(null), defaults);
  assert.deepEqual(sanitizeRecord({ version: 999, settings: { motion: 'lively' }, hidden: true }), defaults);
  assert.deepEqual(sanitizeRecord({ version: 1, settings: { motion: 'still' }, position: { x: 12, y: 20 }, visible: false }), {
    version: 1, settings: { ...DEFAULT_SETTINGS, motion: 'still' }, position: { x: 12, y: 20 },
  });
});

test('window dimensions honor supported scales', () => {
  assert.deepEqual(petSize(1.25), { width: 240, height: 260 });
  assert.deepEqual(petSize(0.75), { width: 144, height: 156 });
  assert.deepEqual(petSize(2), { width: 384, height: 416 });
  assert.deepEqual(petSize(NaN), petSize(1.25));
});

test('first launch is inset at bottom-right of the primary work area', () => {
  assert.deepEqual(defaultPosition(petSize(1.25), primary), { x: 1656, y: 756 });
  assert.deepEqual(clampPosition(null, petSize(1.25), [left, primary], primary), { x: 1656, y: 756 });
});

test('fully visible coordinates are retained, including left-of-primary displays', () => {
  assert.deepEqual(clampPosition({ x: -1000, y: 100 }, petSize(1.25), [primary, left]), { x: -1000, y: 100 });
  assert.deepEqual(clampPosition({ x: 200, y: 100 }, petSize(1.25), [primary, left]), { x: 200, y: 100 });
});

test('an unplugged monitor cannot strand the pet off-screen', () => {
  assert.deepEqual(clampPosition({ x: -1000, y: 100 }, petSize(1.25), [primary]), { x: 0, y: 100 });
  assert.deepEqual(clampPosition({ x: 4000, y: 3000 }, petSize(1.25), [primary]), { x: 1680, y: 780 });
});

test('partially visible windows move fully into the best-overlap display', () => {
  assert.deepEqual(clampPosition({ x: -100, y: 100 }, petSize(1.25), [primary, left]), { x: 0, y: 100 });
  assert.deepEqual(clampPosition({ x: -200, y: 100 }, petSize(1.25), [primary, left]), { x: -240, y: 100 });
});

test('monitor gaps, changed work areas, and tiny displays have deterministic positions', () => {
  const upper = { workArea: { x: 2000, y: -1200, width: 1920, height: 1080 } };
  assert.deepEqual(clampPosition({ x: 1960, y: -700 }, petSize(1.25), [primary, upper]), { x: 2000, y: -700 });
  assert.deepEqual(clampPosition({ x: 1800, y: 900 }, petSize(2), [primary]), { x: 1536, y: 624 });
  const tiny = { x: -50, y: 10, width: 100, height: 100 };
  assert.deepEqual(clampPosition({ x: 400, y: 200 }, petSize(2), [tiny]), { x: -50, y: 10 });
  assert.deepEqual(clampPosition({ x: 400, y: 200 }, petSize(2), []), { x: 24, y: 24 });
});

test('settings store round-trips a sanitized complete record', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-settings-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = createSettingsStore(path.join(folder, 'profile'));
  assert.deepEqual(store.load().settings, DEFAULT_SETTINGS);
  const record = { version: 1, settings: { ...DEFAULT_SETTINGS, scale: 1.5, motion: 'still', gaze: false, alwaysOnTop: false }, position: { x: -123, y: 456 } };
  assert.deepEqual(store.save(record), record);
  assert.deepEqual(store.load(), record);
  assert.deepEqual(fs.readdirSync(path.dirname(store.filename)), ['settings.json']);
  assert.equal(fs.readFileSync(store.filename, 'utf8').endsWith('\n'), true);
});

test('truncated, malformed, oversized, or unsupported settings safely fall back', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-settings-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = createSettingsStore(folder);
  for (const content of ['{', 'null', '[]', JSON.stringify({ version: 2 }), ' '.repeat(65 * 1024)]) {
    fs.writeFileSync(store.filename, content);
    assert.deepEqual(store.load(), { version: 1, settings: { ...DEFAULT_SETTINGS }, position: null });
  }
});

test('atomic replacement failure leaves old settings intact and removes temp file', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andromeda-settings-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = createSettingsStore(folder);
  const original = { version: 1, settings: { ...DEFAULT_SETTINGS }, position: { x: 100, y: 100 } };
  store.save(original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { const error = new Error('simulated read-only target'); error.code = 'EACCES'; throw error; };
    assert.throws(() => store.save({ ...original, position: { x: 200, y: 200 } }), /read-only/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.load(), original);
  assert.deepEqual(fs.readdirSync(folder), ['settings.json']);
});

test('v0.1 settings migrate safely and new toggles reject non-boolean values', () => {
  const old = sanitizeRecord({ version: 1, settings: { scale: 1, gaze: true }, position: { x: 20, y: 40 } });
  assert.equal(old.settings.edgeDock, true);
  assert.equal(old.settings.globalGaze, false);
  assert.equal(old.settings.clickThrough, false);
  for (const key of ['edgeDock', 'globalGaze', 'clickThrough']) {
    assert.deepEqual(validateSettingsPatch({ [key]: true }), { [key]: true });
    assert.throws(() => validateSettingsPatch({ [key]: 'true' }), TypeError);
  }
});
