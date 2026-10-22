import {createCompanionEngine, COMPANION_VERSION, DEFAULT_PREFERENCES} from './shared/companion.mjs';

export const BACKUP_SCHEMA = 'andromeda.backup/v1';
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const STATE_FIELDS = ['version', 'scope', 'profile', 'preferences', 'focus', 'todos', 'mood', 'progression',
  'memories', 'notifications', 'tasks', 'seenEventIds', 'routine', 'lastInteractionAt', 'lastTickAt'];
const COLLECTIONS = ['todos', 'memories', 'notifications', 'tasks', 'seenEventIds'];
const RECORDS = ['profile', 'preferences', 'focus', 'mood', 'progression', 'routine'];
export class BackupError extends TypeError {
  constructor(code, message) {super(message);this.name = 'BackupError';this.code = code;}
}
const fail = (code, message) => {throw new BackupError(code, message);};
function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function equalJSON(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJSON(left[key], right[key]));
}

// Validate descriptors before serialization so a programmatic caller cannot invoke a getter/toJSON.
function boundedJSON(value) {
  let nodes = 0;const seen = new WeakSet();
  function visit(item, depth) {
    if (++nodes > 100000 || depth > 12) fail('STRUCTURE', '备份结构过于复杂，未恢复任何记录。');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {if (!Number.isFinite(item)) fail('STRUCTURE', '备份包含非 JSON 数值。');return;}
    if (typeof item === 'string') {if (item.length > MAX_BACKUP_BYTES) fail('TOO_LARGE', '备份不能超过 2 MiB。');return;}
    if (typeof item !== 'object' || (!Array.isArray(item) && !plainRecord(item)) || seen.has(item)) fail('STRUCTURE', '备份只能包含普通 JSON 数据。');
    if (Array.isArray(item) && item.length > 100000) fail('STRUCTURE', '备份结构过于复杂，未恢复任何记录。');
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length) fail('STRUCTURE', '备份只能包含普通 JSON 数据。');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1) fail('STRUCTURE', '备份数组格式不正确。');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('STRUCTURE', '备份包含不支持的对象字段。');
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) fail('TOO_LARGE', '备份不能超过 2 MiB。');
  return JSON.parse(text);
}

/** Read-only preview. The host must separately ask for confirmation, preserve the old save, and commit. */
export function validateCompanionBackup(value) {
  const backup = boundedJSON(value);
  if (!plainRecord(backup) || Object.keys(backup).some(key => !['schema', 'companion'].includes(key))
    || !Object.hasOwn(backup, 'schema') || !Object.hasOwn(backup, 'companion')) fail('FORMAT', '请选择完整的星璇本地备份；偏好文件不能用于恢复全部记录。');
  if (backup.schema !== BACKUP_SCHEMA) fail('SCHEMA', '不支持此备份格式，未恢复任何记录。');
  const saved = backup.companion;
  if (!plainRecord(saved)) fail('FORMAT', '备份缺少完整陪伴记录，不能用空数据覆盖当前记录。');
  if (saved.version !== COMPANION_VERSION) fail('VERSION', '备份数据版本不受支持，请使用匹配版本处理。');
  if (saved.scope !== 'owner') fail('SCOPE', '只能恢复主人的本地备份，不能导入访客或其他身份存档。');
  if (Object.keys(saved).some(key => !STATE_FIELDS.includes(key)) || STATE_FIELDS.some(key => !Object.hasOwn(saved, key))) fail('FORMAT', '备份字段不完整或包含额外数据，不能用它覆盖当前记录。');
  if (COLLECTIONS.some(key => !Array.isArray(saved[key])) || RECORDS.some(key => !plainRecord(saved[key]))) fail('FORMAT', '备份记录集合损坏，不能将它静默恢复为空列表。');

  const now = Date.now(), engine = createCompanionEngine(saved, {role: 'owner', now: () => now, timezoneOffsetMinutes: -new Date(now).getTimezoneOffset()});
  const state = engine.serialize(), sourceCounts = {}, discarded = {}, recoveredFields = [];
  for (const key of COLLECTIONS) {sourceCounts[key] = saved[key].length;discarded[key] = saved[key].length - state[key].length;}
  const details = rows => rows.reduce((sum, entry) => sum + (Array.isArray(entry?.items) ? entry.items.length : 0), 0);
  sourceCounts.notificationDetails = details(saved.notifications);discarded.notificationDetails = sourceCounts.notificationDetails - details(state.notifications);
  discarded.total = Object.values(discarded).reduce((sum, count) => sum + count, 0);
  const recordTotal = source => ['todos', 'memories', 'notifications', 'tasks'].reduce((sum, key) => sum + source[key].length, 0);
  if (recordTotal(saved) > 0 && recordTotal(state) === 0) fail('EMPTY_AFTER_REPAIR', '备份中的记录全部无效，已拒绝恢复为空记录。请保留原文件并检查内容。');

  const checkFields = (name, keys, ignored = []) => {
    if (Object.keys(saved[name]).some(key => !keys.includes(key) && !ignored.includes(key))) recoveredFields.push(name + '.额外字段');
    for (const key of keys) if (JSON.stringify(saved[name][key]) !== JSON.stringify(state[name][key])) recoveredFields.push(name + '.' + key);
  };
  checkFields('profile', ['name', 'ownerName', 'persona']);
  checkFields('preferences', Object.keys(DEFAULT_PREFERENCES));
  checkFields('progression', ['xp', 'level', 'focusSessions', 'completedTodos']);
  checkFields('mood', ['value', 'updatedAt']);
  const focusPaused = ['running', 'break'].includes(saved.focus.status) && state.focus.status === 'paused';
  checkFields('focus', ['id', 'taskId', 'durationMs', 'remainingMs', 'breakMs', 'startedAt', 'creditedMs', 'rewarded'], ['updatedAt', 'status', 'phase']);
  if (saved.focus.status !== state.focus.status && !focusPaused) recoveredFields.push('focus.status');
  if (saved.lastInteractionAt !== state.lastInteractionAt) recoveredFields.push('lastInteractionAt');
  // A surviving row may still contain unsupported fields or partially invalid detail rows.
  for (const key of ['todos', 'memories', 'notifications', 'tasks']) {
    const originals = new Map(saved[key].filter(plainRecord).map(item => [item.id, item]));
    for (const item of state[key]) {
      const original = originals.get(item.id);
      if (!equalJSON(original, item)) recoveredFields.push(`${key}.${item.id}`);
    }
  }
  const warnings = [];
  if (discarded.total) warnings.push(`有 ${discarded.total} 条无效、重复或超限记录/通知详情不会恢复，请检查分项数量。`);
  if (recoveredFields.length) warnings.push(`有 ${recoveredFields.length} 处字段经过修复、规范化或移除；请查看修复字段。`);
  if (focusPaused) warnings.push('备份中正在进行的专注或休息将恢复为暂停；离线时间不会计入经验。');
  if (recordTotal(saved) === 0) warnings.push('这份备份没有待办、记忆、通知或外部任务；确认恢复会替换当前这些记录。');
  warnings.push('恢复只替换本地陪伴记录；不包含智能服务配置、API Key、应用快捷路径或登录账号。');
  return {state, summary: {todos: state.todos.length, memories: state.memories.length, notifications: state.notifications.length,
    tasks: state.tasks.length, level: state.progression.level, focusStatus: state.focus.status,
    sourceCounts, discarded, recoveredFields, focusPaused, warnings}};
}
