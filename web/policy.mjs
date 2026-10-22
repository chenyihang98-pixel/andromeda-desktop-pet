export const DEFAULT_WEB_PREFERENCES = Object.freeze({motion: 'quiet', sound: false, gaze: true, reducedMotion: false, visualStyle: 'classic', theme: 'night', interaction: true, seasonal: false, inputFeedback: false, readingRewards: false, collapsed: false, dock: null, x: 1, y: 1});
const booleanKeys = ['sound', 'gaze', 'reducedMotion', 'interaction', 'seasonal', 'inputFeedback', 'readingRewards', 'collapsed'];
const portableKeys = ['motion', 'sound', 'reducedMotion', 'visualStyle', 'theme'];
const plainRecord = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeWebPreferences(value) {
  const result = {...DEFAULT_WEB_PREFERENCES};
  if (!plainRecord(value)) return result;
  for (const key of booleanKeys) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (['quiet', 'lively', 'still'].includes(value.motion)) result.motion = value.motion;
  if (['classic', 'studio'].includes(value.visualStyle)) result.visualStyle = value.visualStyle;
  if (['night', 'dawn', 'festive'].includes(value.theme)) result.theme = value.theme;
  if (['left', 'right'].includes(value.dock)) result.dock = value.dock;
  for (const key of ['x', 'y']) if (Number.isFinite(value[key])) result[key] = Math.max(0, Math.min(1, value[key]));
  return result;
}
export function exportWebPreferences(preferences) {
  const clean = normalizeWebPreferences(preferences);
  return {schema: 'andromeda.preferences/v1', preferences: Object.fromEntries(portableKeys.map(key => [key, clean[key]]))};
}
export function importWebPreferences(data, current = {}) {
  if (!plainRecord(data) || data.schema !== 'andromeda.preferences/v1' || !plainRecord(data.preferences)) throw new TypeError('偏好文件格式不正确');
  const clean = Object.fromEntries(portableKeys.filter(key => Object.hasOwn(data.preferences, key)).map(key => [key, data.preferences[key]]));
  return normalizeWebPreferences({...normalizeWebPreferences(current), ...clean});
}
export function safeLink(value, base = 'https://starwright.xyz/') {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const link = new URL(value, base);
    if (link.protocol !== 'https:' && !(link.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(link.hostname))) return null;
    if (link.username || link.password) return null;
    return link.href;
  } catch { return null; }
}
export function cleanText(value, max = 240) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max) : ''; }
export function acceptTaskEvent(event, session) {
  if (!plainRecord(session) || session.authenticated !== true || !cleanText(session.userId, 128)) return null;
  if (!plainRecord(event) || event.userId !== session.userId || !['working', 'waiting', 'completed', 'failed', 'cancelled'].includes(event.status)) return null;
  const eventId = cleanText(event.eventId, 120), taskId = cleanText(event.taskId, 120);
  if (!eventId || !taskId || !/^[a-zA-Z0-9_.:@-]+$/.test(eventId) || !/^[a-zA-Z0-9_.:@-]+$/.test(taskId)) return null;
  return {type: 'task.event', eventId, taskId, status: event.status, title: cleanText(event.title, 80) || taskId, text: cleanText(event.text)};
}
export function placeWidget(preferences, viewport, size) {
  const p = normalizeWebPreferences(preferences), margin = 16;
  const width = Math.max(0, viewport.width), height = Math.max(0, viewport.height);
  const maxX = Math.max(0, width - size.width - margin), maxY = Math.max(0, height - size.height - margin);
  const minX = Math.min(margin, maxX), minY = Math.min(margin, maxY);
  return {left: p.dock === 'left' ? minX : p.dock === 'right' ? maxX : minX + (maxX - minX) * p.x, top: minY + (maxY - minY) * p.y};
}
export function semanticAnimation(action, manifest) {
  const mapping = {greet: 'waving', happy: 'jumping', think: 'running', read: 'review', question: 'waiting', pet: 'waving', sleep: 'waiting', notify: 'review', idle: 'idle', failed: 'failed'};
  const name = mapping[action] || action;
  return manifest?.animations?.[name] ? name : 'idle';
}

/** Temporary geometry only: never rewrites the owner's saved position. */
export function avoidOverlapPlacement(preferences, viewport, expanded, compact, obstacles = [], {forceExpanded = false} = {}) {
  const overlap = (point, size, rect) => point.left < rect.right + 8 && point.left + size.width > rect.left - 8 && point.top < rect.bottom + 8 && point.top + size.height > rect.top - 8;
  const find = size => {
    const preferred = placeWidget(preferences, viewport, size);
    const maxX = Math.max(0, viewport.width - size.width), maxY = Math.max(0, viewport.height - size.height);
    const clamp = ({left, top}) => ({left: Math.max(0, Math.min(maxX, left)), top: Math.max(0, Math.min(maxY, top))});
    const points = [preferred, {left: 8, top: 8}, {left: maxX - 8, top: 8}, {left: 8, top: maxY - 8}, {left: maxX - 8, top: maxY - 8}];
    for (const rect of obstacles) points.push({left: rect.left - size.width - 8, top: preferred.top}, {left: rect.right + 8, top: preferred.top}, {left: preferred.left, top: rect.top - size.height - 8}, {left: preferred.left, top: rect.bottom + 8});
    return points.map(clamp).filter(point => size.width <= viewport.width && size.height <= viewport.height && !obstacles.some(rect => overlap(point, size, rect)))
      .sort((a, b) => Math.hypot(a.left - preferred.left, a.top - preferred.top) - Math.hypot(b.left - preferred.left, b.top - preferred.top))[0] || null;
  };
  const normal = forceExpanded ? placeWidget(preferences, viewport, expanded) : find(expanded);
  if (normal) return {point: normal, collapsed: false};
  return {point: find(compact) || placeWidget(preferences, viewport, compact), collapsed: true};
}
