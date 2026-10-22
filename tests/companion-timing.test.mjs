import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionEngine} from '../src/shared/companion.mjs';
const BASE = Date.UTC(2026, 9, 22, 3);

test('deadline calculation is pure, follows reminders and respects paused focus', () => {
  let time = BASE;
  const engine = createCompanionEngine({}, {now: () => time, timezoneOffsetMinutes: 540});
  engine.dispatch({type: 'preferences.update', patch: {routine: false}});
  assert.equal(engine.nextWakeAt(), null);
  engine.dispatch({type: 'focus.start', durationMinutes: 1});
  assert.equal(engine.nextWakeAt(), BASE + 60_000);
  const todo = engine.dispatch({type: 'todo.add', text: 'due', dueAt: BASE + 20_000}).state.todos[0];
  const before = engine.snapshot(), revision = engine.revision();
  assert.equal(engine.nextWakeAt(), BASE + 20_000);assert.deepEqual(engine.snapshot(), before);assert.equal(engine.revision(), revision);
  time += 20_000;engine.tick();assert.ok(engine.revision() > revision);assert.equal(engine.nextWakeAt(), BASE + 60_000);
  engine.dispatch({type: 'focus.pause'});assert.equal(engine.nextWakeAt(), null);
  engine.dispatch({type: 'todo.snooze', id: todo.id, minutes: 1});assert.equal(engine.nextWakeAt(), time + 60_000);
});

test('routine deadline uses explicit timezone and includes midnight seasonal changes', () => {
  let time = Date.UTC(2026, 10, 30, 14, 59, 50);
  const engine = createCompanionEngine({}, {now: () => time, timezoneOffsetMinutes: 540});
  assert.equal(engine.nextWakeAt(), Date.UTC(2026, 10, 30, 15));
  time += 10_000;const result = engine.tick();assert.equal(result.state.routine.season, 'winter');
  assert.equal(engine.nextWakeAt(), Date.UTC(2026, 10, 30, 21));
  time += 6 * 3_600_000;assert.equal(engine.nextWakeAt(), time);
  assert.equal(engine.tick().events[0].kind, 'routine.changed');
});

test('muted reminders change durable revision; pure mood decay does not create a persistence change', () => {
  let time = BASE;
  const engine = createCompanionEngine({}, {now: () => time});
  engine.dispatch({type: 'preferences.update', patch: {routine: false, remindersMuted: true}});
  engine.dispatch({type: 'todo.add', text: 'silent', dueAt: BASE + 1000});
  let revision = engine.revision();time += 1000;const result = engine.tick();
  assert.equal(result.events.length, 0);assert.equal(result.state.notifications.length, 1);assert.ok(engine.revision() > revision);
  engine.dispatch({type: 'interaction', kind: 'thanks'});revision = engine.revision();assert.equal(engine.nextWakeAt(), time + 30_000);
  time += 30_000;assert.ok(engine.tick().state.mood.value < 4);assert.equal(engine.revision(), revision);
});

test('public projection and scheduling do not serialize private collections', () => {
  const engine = createCompanionEngine({}, {now: () => BASE});
  engine.dispatch({type: 'memory.add', text: 'private memory'});
  const original = JSON.stringify;let calls = 0;
  JSON.stringify = (...args) => {calls++;return original(...args);};
  try {
    for (let i = 0; i < 1000; i++) {const value = engine.publicSnapshot();value.preferences.theme = 'dawn';engine.nextWakeAt();}
    assert.equal(calls, 0);
  } finally {JSON.stringify = original;}
  assert.equal(engine.snapshot().preferences.theme, 'night');assert.equal(engine.publicSnapshot().memories, undefined);
});
