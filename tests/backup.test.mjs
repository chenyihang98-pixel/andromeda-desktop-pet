import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionEngine} from '../src/shared/companion.mjs';
import {validateCompanionBackup, BACKUP_SCHEMA, MAX_BACKUP_BYTES} from '../src/backup.mjs';

function fixture() {
  let number = 0;const engine = createCompanionEngine({}, {role: 'owner', now: () => 1000000, id: prefix => `${prefix}-${++number}`});
  engine.dispatch({type: 'todo.add', text: '待办原文', dueAt: 2000000});
  engine.dispatch({type: 'memory.add', text: '主人主动记忆', source: '主人'});
  engine.dispatch({type: 'task.event', eventId: 'event-1', taskId: 'task-1', status: 'completed', text: '生成完成'});
  return {schema: BACKUP_SCHEMA, companion: engine.serialize()};
}
const errorCode = (value, code) => assert.throws(() => validateCompanionBackup(value), error => error.name === 'BackupError' && error.code === code);

test('backup preview preserves valid owner records and does not mutate source or call platform services', () => {
  const backup = fixture(), raw = JSON.stringify(backup), {state, summary} = validateCompanionBackup(backup);
  assert.equal(summary.todos, 1);assert.equal(summary.memories, 1);assert.equal(summary.notifications, 1);assert.equal(summary.tasks, 1);
  assert.equal(summary.discarded.total, 0);assert.equal(state.memories[0].source, '主人');
  assert.deepEqual(summary.recoveredFields, []);
  assert.equal(JSON.stringify(backup), raw);state.memories[0].text = 'changed';assert.equal(backup.companion.memories[0].text, '主人主动记忆');
  assert.equal(Object.hasOwn(state, 'assistant'), false);assert.equal(Object.hasOwn(state, 'apiKey'), false);
});

test('wrong schema, scope, version, incomplete saves and extra credential fields cannot silently clear data', () => {
  errorCode({}, 'FORMAT');errorCode({schema: 'andromeda.preferences/v1', companion: fixture().companion}, 'SCHEMA');
  for (const scope of ['visitor', 'admin']) {const backup = fixture();backup.companion.scope = scope;errorCode(backup, 'SCOPE');}
  const version = fixture();version.companion.version = 2;errorCode(version, 'VERSION');
  const partial = {schema: BACKUP_SCHEMA, companion: {version: 1, scope: 'owner'}};errorCode(partial, 'FORMAT');
  const missing = fixture();delete missing.companion.memories;errorCode(missing, 'FORMAT');
  const wrongCollection = fixture();wrongCollection.companion.todos = {};errorCode(wrongCollection, 'FORMAT');
  errorCode({...fixture(), assistant: {apiKey: 'do-not-import'}}, 'FORMAT');
  const stateSecret = fixture();stateSecret.companion.apiKey = 'do-not-import';errorCode(stateSecret, 'FORMAT');
});

test('invalid, duplicate and limited records are counted in repair preview instead of silently discarded', () => {
  const backup = fixture();backup.companion.todos.push({...backup.companion.todos[0]}, {id: 'bad'});
  backup.companion.memories.push({id: 'broken'});backup.companion.seenEventIds.push('event-1', 'invalid id');
  backup.companion.notifications[0].items.push({id: 'bad-detail'});
  backup.companion.profile.ownerName = 123;backup.companion.progression.level = 999;
  const result = validateCompanionBackup(backup);
  assert.equal(result.summary.discarded.todos, 2);assert.equal(result.summary.discarded.memories, 1);
  assert.equal(result.summary.discarded.seenEventIds, 2);assert.equal(result.summary.discarded.notificationDetails, 1);
  assert.equal(result.summary.discarded.total, 6);assert.ok(result.summary.recoveredFields.includes('profile.ownerName'));
  assert.ok(result.summary.recoveredFields.includes('progression.level'));assert.equal(result.state.progression.level, 1);
  assert.ok(result.summary.warnings.some(text => /6 条/.test(text)));
});

test('active focus restores paused with no offline reward and preview states the transition', () => {
  const engine = createCompanionEngine({}, {now: () => 1000000});engine.dispatch({type: 'focus.start', durationMinutes: 25});
  const saved = engine.serialize(), {state, summary} = validateCompanionBackup({schema: BACKUP_SCHEMA, companion: saved});
  assert.equal(summary.focusPaused, true);assert.equal(summary.focusStatus, 'paused');
  assert.equal(state.focus.remainingMs, saved.focus.remainingMs);assert.equal(state.progression.xp, 0);
  assert.ok(summary.warnings.some(text => /恢复为暂停/.test(text)));
});

test('an intentional empty full backup is previewed clearly while wholly broken records are refused', () => {
  const empty = {schema: BACKUP_SCHEMA, companion: createCompanionEngine().serialize()};
  const result = validateCompanionBackup(empty);assert.equal(result.summary.todos, 0);assert.ok(result.summary.warnings.some(text => /没有待办/.test(text)));
  empty.companion.todos = [{id: 'broken'}];errorCode(empty, 'EMPTY_AFTER_REPAIR');
});

test('backup limit uses UTF-8 bytes and rejects getters, scripts, cycles and prototype fields without invoking them', () => {
  const large = fixture();large.companion.profile.persona = '界'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3));errorCode(large, 'TOO_LARGE');
  let getterCalled = false;const getter = Object.defineProperty({}, 'schema', {enumerable: true, get() {getterCalled = true;return BACKUP_SCHEMA;}});
  errorCode(getter, 'STRUCTURE');assert.equal(getterCalled, false);
  errorCode({...fixture(), toJSON() {throw new Error('should not run');}}, 'STRUCTURE');
  const cyclic = fixture();cyclic.companion.todos.push(cyclic);errorCode(cyclic, 'STRUCTURE');
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');errorCode(polluted, 'STRUCTURE');assert.equal({}.polluted, undefined);
});
