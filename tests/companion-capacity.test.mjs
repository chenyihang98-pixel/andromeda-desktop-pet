import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionEngine, LIMITS, MAX_COMPANION_BYTES} from '../src/shared/companion.mjs';
import {validateCompanionBackup, MAX_BACKUP_BYTES} from '../src/backup.mjs';

const MAX_TIME = 8_640_000_000_000_000;
const NOW = MAX_TIME - 1000;
const identifier = (prefix, number = 0) => `${prefix}-${number}`.padEnd(120, 'x');
const text = count => '汉'.repeat(count);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const backup = companion => ({schema: 'andromeda.backup/v1', companion});

// A BMP character uses the maximum three UTF-8 bytes per allowed JS string
// code unit. IDs permit ASCII only; every ID is therefore 120 bytes here.
// Fill every independent collection, optional target and bounded text field;
// do not rely on the smaller set of notification kinds the current UI produces.
function maximumState() {
  const state = createCompanionEngine({}, {now: () => NOW}).serialize();
  state.profile = {name: text(40), ownerName: text(40), persona: text(1000)};
  state.preferences = {motion: 'lively', sound: false, reducedMotion: false, remindersMuted: false,
    routine: false, focusMinutes: 240, breakMinutes: 60, visualStyle: 'classic', theme: 'festive', movement: 'follow'};
  state.focus = {id: identifier('focus'), status: 'completed', phase: 'break', taskId: identifier('task'),
    durationMs: 240 * 60_000, remainingMs: 240 * 60_000, breakMs: 60 * 60_000,
    startedAt: MAX_TIME, updatedAt: MAX_TIME, creditedMs: 240 * 60_000, rewarded: false};
  state.todos = Array.from({length: LIMITS.todos}, (_, index) => ({id: identifier('todo', index), text: text(LIMITS.text),
    dueAt: MAX_TIME, status: 'completed', createdAt: MAX_TIME, updatedAt: MAX_TIME,
    completedAt: MAX_TIME, remindedAt: MAX_TIME, rewarded: false}));
  state.memories = Array.from({length: LIMITS.memories}, (_, index) => ({id: identifier('memory', index), text: text(LIMITS.memoryText),
    source: text(100), createdAt: MAX_TIME, updatedAt: MAX_TIME}));
  state.notifications = Array.from({length: LIMITS.notifications}, (_, index) => ({id: identifier('notice', index),
    kind: text(50), action: text(50), text: text(LIMITS.text), priority: 100, count: 1_000_000,
    taskId: identifier('task', index), createdAt: MAX_TIME, updatedAt: MAX_TIME,
    items: Array.from({length: LIMITS.notificationItems}, (_, itemIndex) => ({id: identifier(`item-${index}`, itemIndex),
      text: text(LIMITS.text), taskId: identifier('task', itemIndex)}))}));
  state.tasks = Array.from({length: LIMITS.tasks}, (_, index) => ({id: identifier('task', index), title: text(200),
    status: 'completed', text: text(LIMITS.text), updatedAt: MAX_TIME}));
  state.seenEventIds = Array.from({length: LIMITS.seenEvents}, (_, index) => identifier('seen', index));
  state.mood = {value: -99.99999999999999, updatedAt: MAX_TIME};
  state.progression = {xp: 1_000_000_000, level: 3163, focusSessions: 1_000_000, completedTodos: 1_000_000};
  state.lastInteractionAt = MAX_TIME;state.lastTickAt = MAX_TIME;
  return state;
}

test('all bounded domain fields and collections at maximum UTF-8 capacity fit one restorable save', t => {
  assert.equal(MAX_COMPANION_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_BACKUP_BYTES, MAX_COMPANION_BYTES);
  const engine = createCompanionEngine(maximumState(), {now: () => NOW});
  const serialized = engine.serialize(), complete = backup(serialized);
  for (const key of ['todos', 'memories', 'notifications', 'tasks']) assert.equal(serialized[key].length, LIMITS[key]);
  assert.equal(serialized.seenEventIds.length, LIMITS.seenEvents);
  assert.ok(serialized.notifications.every(entry => entry.items.length === LIMITS.notificationItems));
  assert.equal(serialized.profile.persona, text(1000));assert.equal(serialized.memories[0].source, text(100));
  assert.ok(bytes(serialized) > 2 * 1024 * 1024, 'This fixture must reproduce the previous persistence limit failure');
  assert.ok(bytes(complete) < MAX_COMPANION_BYTES);
  t.diagnostic(`Full bounded UTF-8 backup: ${bytes(complete)} / ${MAX_COMPANION_BYTES} bytes`);
  const restored = validateCompanionBackup(complete);
  assert.equal(restored.summary.discarded.total, 0);
  assert.equal(restored.state.memories.length, LIMITS.memories);
  assert.equal(restored.state.notifications.length, LIMITS.notifications);
});

test('a future due tick and merged detail at full capacity remain inside the same storage budget', () => {
  const saved = maximumState();let time = NOW, serial = 0;
  saved.todos[0] = {...saved.todos[0], status: 'open', completedAt: null, remindedAt: null};
  saved.notifications[0].kind = 'todo.due';saved.notifications[0].action = 'notify';
  const engine = createCompanionEngine(saved, {now: () => time, id: prefix => identifier('new-' + prefix, ++serial)});
  time = MAX_TIME;
  const result = engine.tick();
  assert.equal(result.events.filter(event => event.kind === 'todo.due').length, 1);
  assert.equal(result.state.notifications.length, LIMITS.notifications);
  assert.equal(result.state.notifications[0].items.length, LIMITS.notificationItems);
  assert.equal(result.state.notifications[0].items.at(-1).text, text(LIMITS.text));
  assert.ok(bytes(backup(engine.serialize())) < MAX_COMPANION_BYTES);
  const restored = validateCompanionBackup(backup(engine.serialize()));assert.equal(restored.summary.discarded.total, 0);
});
test('unpaired UTF-16 cannot inflate saved JSON while valid emoji remain accepted', () => {
  const engine = createCompanionEngine();
  engine.dispatch({type: 'memory.add', text: '🌠'.repeat(1000), source: '主人'});
  const before = engine.snapshot();
  for (const invalid of ['\ud800'.repeat(2000), '\udc00', '开头\ud800结尾']) {
    assert.throws(() => engine.dispatch({type: 'memory.add', text: invalid, source: '主人'}));
    assert.deepEqual(engine.snapshot(), before);
  }
  const saved = engine.serialize();
  saved.memories.push({...saved.memories[0], id: 'invalid-utf16-memory', text: '\ud800'.repeat(2000)});
  const restored = validateCompanionBackup(backup(saved));
  assert.equal(restored.state.memories.length, 1);assert.equal(restored.state.memories[0].text, '🌠'.repeat(1000));
  assert.equal(restored.summary.discarded.memories, 1);assert.ok(restored.summary.warnings.some(text => text.includes('无效')));
});
