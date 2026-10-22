import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionEngine, exportPreferences, LIMITS } from '../src/shared/companion.mjs';

const BASE = Date.UTC(2026, 9, 22, 0, 0, 0);
function fixture(saved = {}, options = {}) {
  let time = BASE, count = 0;
  return { engine: createCompanionEngine(saved, { now: () => time, id: prefix => `${prefix}-${++count}`, ...options }),
    advance: amount => { time += amount; }, setTime: value => { time = value; } };
}
const command = (engine, type, rest = {}) => engine.dispatch({ type, ...rest });

test('identity changes and exported snapshots cannot mutate the engine', () => {
  const { engine } = fixture();
  command(engine, 'profile.update', { patch: { name: '星璇', ownerName: '阿星', persona: '清楚、安静。' } });
  const snapshot = engine.snapshot(); snapshot.profile.ownerName = 'changed';
  assert.equal(engine.snapshot().profile.ownerName, '阿星');
  assert.equal(command(engine, 'interaction', { kind: 'greet' }).events[0].text, '你好，阿星。');
  const restored = fixture(engine.serialize()).engine;
  assert.equal(restored.snapshot().profile.ownerName, '阿星');
});

test('visitor and admin scopes never restore an owner private archive', () => {
  const { engine } = fixture();
  command(engine, 'memory.add', { text: 'private', source: 'user' });
  command(engine, 'todo.add', { text: 'private task' });
  command(engine, 'profile.update', { patch: { ownerName: 'private owner' } });
  for (const role of ['visitor', 'admin']) {
    const other = fixture(engine.serialize(), { role }).engine.snapshot();
    assert.equal(other.scope, role); assert.equal(other.memories.length, 0); assert.equal(other.todos.length, 0);
    assert.notEqual(other.profile.ownerName, 'private owner');
  }
  assert.throws(() => command(fixture({}, { role: 'visitor' }).engine, 'task.event', { eventId: 'e', taskId: 't', status: 'working' }));
});

test('preference export/import is portable and rejects identity or unknown data', () => {
  const { engine } = fixture();
  command(engine, 'preferences.update', { patch: { motion: 'still', sound: true, focusMinutes: 45 } });
  command(engine, 'memory.add', { text: 'secret' });
  const exported = command(engine, 'preferences.export').data;
  assert.deepEqual(exported, exportPreferences(engine.snapshot()));
  assert.equal(JSON.stringify(exported).includes('secret'), false);
  const visitor = fixture({}, { role: 'visitor' }).engine;
  command(visitor, 'preferences.import', { data: exported });
  assert.equal(visitor.snapshot().preferences.focusMinutes, 45);
  assert.equal(visitor.snapshot().scope, 'visitor');
  assert.throws(() => command(visitor, 'preferences.import', { data: { ...exported, profile: { ownerName: 'leaked' } } }));
  assert.throws(() => command(visitor, 'preferences.update', { patch: { focusMinutes: 0 } }));
  assert.throws(() => command(visitor, 'preferences.update', { patch: { sound: 'true' } }));
});

test('visual styles, themes and optional movement remain explicit validated preferences', () => {
  const { engine } = fixture();
  assert.equal(engine.snapshot().preferences.visualStyle, 'classic'); assert.equal(engine.snapshot().preferences.movement, 'off');
  command(engine, 'preferences.update', { patch: { visualStyle: 'studio', theme: 'festive', movement: 'toss' } });
  const restored = fixture(engine.serialize()).engine;
  assert.equal(restored.snapshot().preferences.visualStyle, 'studio'); assert.equal(restored.snapshot().preferences.theme, 'festive');
  assert.equal(restored.snapshot().preferences.movement, 'toss');
  assert.throws(() => command(engine, 'preferences.update', { patch: { visualStyle: 'remote-script' } }));
  assert.throws(() => command(engine, 'preferences.update', { patch: { theme: 'unknown' } }));
  assert.throws(() => command(engine, 'preferences.update', { patch: { movement: 'always-track' } }));
});

test('malformed persistent records recover useful fields and never trust stored level', () => {
  const clean = fixture().engine.serialize();
  clean.preferences = { sound: 'yes', motion: 'lively', focusMinutes: Infinity };
  clean.progression = { xp: 400, level: 9999, completedTodos: -1, focusSessions: 3 };
  clean.todos = [{ id: 'bad', text: '<script>plain text</script>', dueAt: -4 }];
  clean.focus = { status: 'running', remainingMs: -1 };
  const restored = fixture(clean).engine.snapshot();
  assert.equal(restored.preferences.motion, 'lively'); assert.equal(restored.preferences.sound, false);
  assert.equal(restored.progression.level, 3); assert.equal(restored.progression.completedTodos, 0);
  assert.equal(restored.todos.length, 0); assert.equal(restored.focus.status, 'idle');
});

test('validation is atomic even when a reminder becomes due during a rejected dispatch', () => {
  const { engine, advance } = fixture();
  command(engine, 'todo.add', { text: 'due', dueAt: BASE + 1000 });
  const before = engine.snapshot(); advance(1000);
  assert.throws(() => command(engine, 'todo.update', { id: before.todos[0].id, patch: { text: '' } }));
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(engine.tick().events.filter(event => event.kind === 'todo.due').length, 1);
  let getterCalled = false;
  const malicious = { type: 'profile.update', get patch() { getterCalled = true; return {}; } };
  assert.throws(() => engine.dispatch(malicious)); assert.equal(getterCalled, false);
  assert.throws(() => engine.dispatch({ type: 'unknown.command' }));
});

test('focus pause/resume preserves elapsed work and rewards completion exactly once', () => {
  const { engine, advance } = fixture();
  command(engine, 'todo.add', { text: 'write' }); const todoId = engine.snapshot().todos[0].id;
  command(engine, 'focus.start', { taskId: todoId, durationMinutes: 1, breakMinutes: 1 });
  advance(30_000); command(engine, 'focus.pause');
  assert.equal(engine.snapshot().focus.remainingMs, 30_000);
  advance(3_600_000); engine.tick(); assert.equal(engine.snapshot().focus.remainingMs, 30_000);
  command(engine, 'focus.resume'); advance(30_000);
  const done = engine.tick();
  assert.equal(done.state.focus.status, 'completed'); assert.equal(done.state.progression.xp, 2);
  assert.equal(done.state.progression.focusSessions, 1); assert.equal(done.events[0].kind, 'focus.completed');
  assert.equal(engine.tick().events.length, 0); assert.equal(command(engine, 'focus.finish').events.length, 0);
  assert.equal(engine.snapshot().progression.xp, 2);
  command(engine, 'focus.break'); advance(60_000);
  assert.equal(engine.tick().events[0].kind, 'focus.break-completed');
  assert.equal(engine.snapshot().focus.status, 'idle'); assert.equal(engine.snapshot().progression.xp, 2);
});

test('focus cancelled or finished immediately cannot manufacture XP', () => {
  const { engine, advance } = fixture();
  command(engine, 'focus.start', { durationMinutes: 1 });
  assert.throws(() => command(engine, 'focus.start'));
  command(engine, 'focus.finish'); assert.equal(engine.snapshot().progression.xp, 0);
  command(engine, 'focus.start', { durationMinutes: 1 }); advance(30_000); command(engine, 'focus.cancel');
  advance(3_600_000); engine.tick(); assert.equal(engine.snapshot().progression.xp, 0);
  assert.equal(engine.snapshot().focus.status, 'cancelled');
  assert.throws(() => command(engine, 'focus.break'));
});

test('active focus restores paused without counting closed-app time or replaying completion', () => {
  const live = fixture(); command(live.engine, 'focus.start', { durationMinutes: 1 }); live.advance(30_000);
  let time = BASE + 10 * 86_400_000;
  const restored = createCompanionEngine(live.engine.serialize(), { now: () => time });
  assert.equal(restored.snapshot().focus.status, 'paused'); assert.equal(restored.snapshot().focus.remainingMs, 30_000);
  assert.equal(restored.tick().events.length, 0); assert.equal(restored.snapshot().progression.xp, 0);
  command(restored, 'focus.resume'); time += 30_000;
  assert.equal(restored.tick().state.progression.xp, 2);
});

test('backward clock changes cannot duplicate focus elapsed time', () => {
  const { engine, setTime } = fixture(); command(engine, 'focus.start', { durationMinutes: 1 });
  setTime(BASE + 30_000); engine.tick(); setTime(BASE + 20_000); engine.tick();
  setTime(BASE + 40_000); engine.tick();
  assert.equal(engine.snapshot().focus.creditedMs, 40_000); assert.equal(engine.snapshot().focus.remainingMs, 20_000);
});

test('due reminders deduplicate across ticks and reloads; snooze creates one later reminder', () => {
  const first = fixture(); command(first.engine, 'todo.add', { text: '喝水', dueAt: BASE + 60_000 });
  const todoId = first.engine.snapshot().todos[0].id;
  first.advance(60_000); assert.equal(first.engine.tick().events.length, 1);
  assert.equal(first.engine.tick().events.length, 0);
  const restored = fixture(first.engine.serialize()); restored.setTime(BASE + 60_000);
  assert.equal(restored.engine.tick().events.length, 0);
  command(restored.engine, 'todo.snooze', { id: todoId, minutes: 5 });
  restored.advance(5 * 60_000 - 1); assert.equal(restored.engine.tick().events.length, 0);
  restored.advance(1); assert.equal(restored.engine.tick().events.length, 1);
  assert.equal(restored.engine.snapshot().notifications[0].count, 2);
});

test('read-only exports never consume or acknowledge pending due events', () => {
  const { engine, advance } = fixture(); command(engine, 'todo.add', { text: 'due', dueAt: BASE + 1000 });
  const before = engine.snapshot(); advance(1000);
  assert.equal(command(engine, 'preferences.export').events.length, 0);
  assert.equal(command(engine, 'memory.export').events.length, 0);
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(engine.tick().events[0].kind, 'todo.due');
});

test('todo completion rewards once, cancellation/delete never removes earned XP', () => {
  const { engine } = fixture(); command(engine, 'todo.add', { text: 'write' }); const id = engine.snapshot().todos[0].id;
  command(engine, 'todo.complete', { id }); assert.equal(engine.snapshot().progression.xp, 10);
  command(engine, 'todo.complete', { id }); assert.equal(engine.snapshot().progression.xp, 10);
  const restored = fixture(engine.serialize()).engine; command(restored, 'todo.complete', { id });
  assert.equal(restored.snapshot().progression.xp, 10);
  assert.throws(() => command(restored, 'todo.snooze', { id, minutes: 1 }));
  command(restored, 'todo.delete', { id }); assert.equal(restored.snapshot().progression.xp, 10);
});

test('mute keeps pending cards while suppressing reminder actions and does not replay on unmute', () => {
  const { engine, advance } = fixture(); command(engine, 'reminders.mute', { muted: true });
  command(engine, 'todo.add', { text: 'take a break', dueAt: BASE + 1000 }); advance(1000);
  assert.equal(engine.tick().events.length, 0); assert.equal(engine.snapshot().notifications.length, 1);
  assert.equal(command(engine, 'reminders.mute', { muted: false }).events.length, 0);
  const notificationId = engine.snapshot().notifications[0].id;
  command(engine, 'notification.ack', { id: notificationId }); assert.equal(engine.snapshot().notifications.length, 0);
});

test('task cards merge with bounded details and duplicate event IDs have no effect', () => {
  const { engine } = fixture();
  for (let i = 0; i < 25; i++) command(engine, 'task.event', { eventId: `event-${i}`, taskId: `task-${i}`, title: `任务 ${i}`, status: 'completed' });
  const state = engine.snapshot(); assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].count, 25); assert.equal(state.notifications[0].items.length, LIMITS.notificationItems);
  assert.equal(state.notifications[0].taskId, undefined);
  assert.equal(command(engine, 'task.event', { eventId: 'event-24', taskId: 'task-24', status: 'completed' }).events.length, 0);
  assert.equal(engine.snapshot().notifications[0].count, 25);
  const restored = fixture(engine.serialize()).engine;
  assert.equal(command(restored, 'task.event', { eventId: 'event-24', taskId: 'task-24', status: 'failed' }).events.length, 0);
  assert.equal(restored.snapshot().tasks.at(-1).status, 'completed');
});

test('new IDs with unchanged task status and content do not repeatedly notify', () => {
  const { engine } = fixture();
  command(engine, 'task.event', { eventId: 'a', taskId: 'job', status: 'working', title: 'build' });
  const done = command(engine, 'task.event', { eventId: 'b', taskId: 'job', status: 'completed', title: 'build' });
  assert.equal(done.events[0].action, 'happy');
  assert.equal(command(engine, 'task.event', { eventId: 'c', taskId: 'job', status: 'completed', title: 'build' }).events.length, 0);
  assert.equal(engine.snapshot().notifications[0].count, 1);
  assert.throws(() => command(engine, 'task.event', { eventId: 'd', taskId: 'job', status: 'execute-shell' }));
});

test('memory provenance and creation time survive edits; forget and export are explicit', () => {
  const { engine, advance } = fixture();
  command(engine, 'memory.add', { text: '喜欢安静', source: 'user-confirmed' }); const original = engine.snapshot().memories[0];
  advance(1000); command(engine, 'memory.update', { id: original.id, text: '上午喜欢安静' });
  const exported = command(engine, 'memory.export').data;
  assert.equal(exported.memories[0].createdAt, BASE); assert.equal(exported.memories[0].updatedAt, BASE + 1000);
  assert.equal(exported.memories[0].source, 'user-confirmed');
  exported.memories[0].text = 'changed'; assert.equal(engine.snapshot().memories[0].text, '上午喜欢安静');
  command(engine, 'memory.forget', { id: original.id }); assert.equal(engine.snapshot().memories.length, 0);
});

test('mood returns gently to neutral, offline time never deducts progression, clicks have reward cooldown', () => {
  const { engine, advance } = fixture(); command(engine, 'interaction', { kind: 'pet' });
  const first = engine.snapshot(); command(engine, 'interaction', { kind: 'pet' });
  assert.equal(engine.snapshot().progression.xp, first.progression.xp);
  advance(20 * 86_400_000); engine.tick();
  assert.equal(engine.snapshot().mood.value, 0); assert.equal(engine.snapshot().progression.xp, first.progression.xp);
  command(engine, 'interaction', { kind: 'thanks' }); assert.equal(engine.snapshot().progression.xp, first.progression.xp + 1);
});

test('routine uses explicit timezone, handles seasons and can be disabled without timers', () => {
  const { engine, setTime } = fixture({}, { timezoneOffsetMinutes: 540 });
  assert.equal(engine.tick().state.routine.period, 'morning');
  assert.equal(engine.snapshot().routine.season, 'autumn');
  setTime(Date.UTC(2026, 11, 1, 15)); assert.equal(engine.tick().state.routine.period, 'night');
  assert.equal(engine.snapshot().routine.season, 'winter');
  command(engine, 'preferences.update', { patch: { routine: false } });
  const before = engine.snapshot().routine; setTime(Date.UTC(2027, 3, 1, 2)); engine.tick();
  assert.deepEqual(engine.snapshot().routine, before);
});
