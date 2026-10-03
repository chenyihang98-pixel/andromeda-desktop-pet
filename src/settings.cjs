'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN_SCALE = 0.75;
const MAX_SCALE = 2;
const BASE_SIZE = Object.freeze({ width: 192, height: 208 });
const DEFAULT_SETTINGS = Object.freeze({
  scale: 1.25,
  motion: 'quiet',
  gaze: false,
  alwaysOnTop: true,
  edgeDock: true,
  globalGaze: false,
  clickThrough: false,
  autoHideFullscreen: false,
});
const MOTIONS = Object.freeze(['quiet', 'still', 'lively']);
const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!isRecord(value)) return settings;
  if (typeof value.scale === 'number' && Number.isFinite(value.scale)) {
    settings.scale = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value.scale)) * 100) / 100;
  }
  if (MOTIONS.includes(value.motion)) settings.motion = value.motion;
  for (const key of ['gaze', 'alwaysOnTop', 'edgeDock', 'globalGaze', 'clickThrough', 'autoHideFullscreen']) {
    if (typeof value[key] === 'boolean') settings[key] = value[key];
  }
  return settings;
}

// IPC patches are stricter than saved preferences: reject the whole patch, never
// partly apply an unexpected or malformed request.
function validateSettingsPatch(value) {
  if (!isRecord(value)) throw new TypeError('设置必须是普通对象');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !SETTINGS_KEYS.includes(key))) {
    throw new TypeError('包含未知设置');
  }
  for (const key of keys) {
    const item = value[key];
    if (key === 'scale' && (typeof item !== 'number' || !Number.isFinite(item) || item < MIN_SCALE || item > MAX_SCALE)) {
      throw new TypeError('缩放范围为 0.75–2');
    }
    if (key === 'motion' && !MOTIONS.includes(item)) throw new TypeError('无效的动作模式');
    if (['gaze', 'alwaysOnTop', 'edgeDock', 'globalGaze', 'clickThrough', 'autoHideFullscreen'].includes(key) && typeof item !== 'boolean') {
      throw new TypeError('开关设置必须为布尔值');
    }
  }
  const clean = {};
  for (const key of keys) clean[key] = key === 'scale' ? Math.round(value[key] * 100) / 100 : value[key];
  return clean;
}

function sanitizePosition(value) {
  if (!isRecord(value)) return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  if (Math.abs(value.x) > 10_000_000 || Math.abs(value.y) > 10_000_000) return null;
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function sanitizeRecord(value) {
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, position: null };
  }
  return {
    version: 1,
    settings: sanitizeSettings(value.settings),
    position: sanitizePosition(value.position),
  };
}

function petSize(scale) {
  const safeScale = sanitizeSettings({ scale }).scale;
  return { width: Math.round(BASE_SIZE.width * safeScale), height: Math.round(BASE_SIZE.height * safeScale) };
}

function workAreas(displays) {
  return displays.map((display) => display.workArea || display).filter((area) => (
    area && Number.isFinite(area.x) && Number.isFinite(area.y)
    && Number.isFinite(area.width) && area.width > 0
    && Number.isFinite(area.height) && area.height > 0
  ));
}

function clampToArea(position, size, area) {
  return {
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + Math.max(0, area.width - size.width)))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + Math.max(0, area.height - size.height)))),
  };
}

function defaultPosition(size, display) {
  const area = workAreas([display])[0];
  if (!area) return { x: 24, y: 24 };
  return clampToArea({ x: area.x + area.width - size.width - 24, y: area.y + area.height - size.height - 24 }, size, area);
}

// Choose a monitor by the largest overlap, then the shortest distance to a
// fully visible position. This handles removed monitors and negative origins.
function clampPosition(position, size, displays, primaryDisplay = displays[0]) {
  const areas = workAreas(displays);
  const point = sanitizePosition(position);
  if (!point) return defaultPosition(size, primaryDisplay);
  if (areas.length === 0) return { x: 24, y: 24 };
  let best = null;
  for (const area of areas) {
    const candidate = clampToArea(point, size, area);
    const overlapWidth = Math.max(0, Math.min(point.x + size.width, area.x + area.width) - Math.max(point.x, area.x));
    const overlapHeight = Math.max(0, Math.min(point.y + size.height, area.y + area.height) - Math.max(point.y, area.y));
    const overlap = overlapWidth * overlapHeight;
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.distance)) {
      best = { position: candidate, overlap, distance };
    }
  }
  return best.position;
}

function createSettingsStore(directory) {
  const filename = path.join(directory, 'settings.json');
  return {
    filename,
    load() {
      try {
        // Preferences are tiny; reject unexpectedly large files before reading.
        if (fs.statSync(filename).size > 64 * 1024) return sanitizeRecord(null);
        return sanitizeRecord(JSON.parse(fs.readFileSync(filename, 'utf8')));
      } catch {
        return sanitizeRecord(null);
      }
    },
    save(record) {
      const clean = sanitizeRecord(record);
      fs.mkdirSync(directory, { recursive: true });
      const temporary = path.join(directory, `.settings-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        // Same-directory rename replaces the previous complete file atomically.
        fs.renameSync(temporary, filename);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // Windows does not permit opening directories for fsync. The file was
      // already flushed; on supported platforms, also flush the rename.
      let directoryDescriptor;
      try {
        directoryDescriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(directoryDescriptor);
      } catch { /* Best-effort directory durability. */ }
      finally { if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor); }
      return clean;
    },
  };
}

module.exports = {
  BASE_SIZE, DEFAULT_SETTINGS, MIN_SCALE, MAX_SCALE, MOTIONS,
  sanitizeSettings, validateSettingsPatch, sanitizePosition, sanitizeRecord,
  petSize, defaultPosition, clampPosition, createSettingsStore,
};
