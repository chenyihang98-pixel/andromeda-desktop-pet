import test from 'node:test';
import assert from 'node:assert/strict';
import { createBehaviorScheduler } from '../src/shared/behavior.mjs';

function fixture() { let time = 1000; return { scheduler: createBehaviorScheduler({ now: () => time }), advance: amount => { time += amount; } }; }
const action = (id, name, priority, durationMs = 1000, extra = {}) => ({ id, action: name, priority, durationMs, ...extra });

test('next wakeup follows completion, cooldown and suspension without polling or mutation', () => {
  const {scheduler, advance} = fixture();assert.equal(scheduler.nextDelay(), null);assert.equal(scheduler.isActive(), false);
  scheduler.enqueue(action('a', 'pet', 80, 100));assert.equal(scheduler.isActive(), true);assert.equal(scheduler.nextDelay(), 100);
  advance(30);const before=scheduler.snapshot();assert.equal(scheduler.nextDelay(),70);assert.deepEqual(scheduler.snapshot(),before);
  scheduler.enqueue(action('b', 'pet', 80, 100));advance(70);scheduler.tick();
  assert.equal(scheduler.nextDelay(),1400);assert.equal(scheduler.isActive(),false);
  scheduler.setContext({hidden:true});advance(10000);assert.equal(scheduler.nextDelay(),null);
  scheduler.setContext({hidden:false});assert.equal(scheduler.nextDelay(),100);
  scheduler.setContext({dragging:true});advance(9000);assert.equal(scheduler.nextDelay(),null);
  scheduler.setContext({dragging:false});assert.equal(scheduler.nextDelay(),100);
  advance(100);assert.equal(scheduler.nextDelay(),1);scheduler.tick();assert.equal(scheduler.nextDelay(),null);
});

test('manual action preempts low priority, then resumes remaining time instead of replaying it', () => {
  const { scheduler, advance } = fixture();
  scheduler.enqueue(action('idle-1', 'idle', 10, 2000)); advance(500);
  assert.equal(scheduler.enqueue(action('pet-1', 'pet', 80)).active.id, 'pet-1');
  advance(1000); const resumed = scheduler.tick();
  assert.equal(resumed.active.id, 'idle-1'); assert.equal(resumed.active.remainingMs, 1500);
  advance(1500); assert.equal(scheduler.tick().active, null);
});

test('hidden/dragged context suspends work and cannot start notification actions or wake a host', () => {
  const { scheduler, advance } = fixture(); scheduler.enqueue(action('a', 'think', 50, 2000)); advance(500);
  const hidden = scheduler.setContext({ hidden: true }); assert.equal(hidden.active.remainingMs, 1500); assert.equal(hidden.active.suspended, true);
  scheduler.enqueue(action('b', 'happy', 60)); advance(100_000);
  assert.equal(scheduler.tick().active.remainingMs, 1500);
  const restored = scheduler.setContext({ hidden: false }); assert.equal(restored.active.id, 'b');
  scheduler.setContext({ dragging: true }); advance(1000); assert.equal(scheduler.tick().active.remainingMs, 1000);
  scheduler.setContext({ dragging: false }); advance(1000); assert.equal(scheduler.tick().active.id, 'a');
});

test('cooldown defers repeated action and a different eligible action can run', () => {
  const { scheduler, advance } = fixture(); scheduler.enqueue(action('a', 'pet', 80, 100)); advance(100); scheduler.tick();
  assert.equal(scheduler.enqueue(action('b', 'pet', 80, 100)).active, null);
  assert.equal(scheduler.enqueue(action('c', 'greet', 50, 100)).active.id, 'c');
  advance(100); scheduler.tick(); advance(1300); assert.equal(scheduler.tick().active.id, 'b');
});

test('task completion removes obsolete working action rather than restoring it after success', () => {
  const { scheduler, advance } = fixture();
  scheduler.enqueue(action('a', 'think', 50, 2000, { kind: 'task.working', taskId: 'task-1' }));
  scheduler.enqueue(action('b', 'happy', 60, 1000, { kind: 'task.completed', taskId: 'task-1' }));
  assert.equal(scheduler.snapshot().active.id, 'b'); assert.equal(scheduler.snapshot().queue.length, 0);
  advance(1000); assert.equal(scheduler.tick().active, null);
});

test('event deduplication, bounded queue, reduced motion and invalid contexts are predictable', () => {
  const scheduler = createBehaviorScheduler({ now: () => 1000, maxQueue: 2 }); scheduler.setContext({ hidden: true, reducedMotion: true });
  scheduler.enqueue(action('a', 'happy', 60, 5000)); scheduler.enqueue(action('a', 'happy', 60, 5000));
  scheduler.enqueue(action('b', 'think', 50)); scheduler.enqueue(action('c', 'idle', 10));
  assert.equal(scheduler.snapshot().queue.length, 2);
  const active = scheduler.setContext({ hidden: false }).active; assert.equal(active.static, true); assert.equal(active.remainingMs, 900);
  const before = scheduler.snapshot(); assert.throws(() => scheduler.setContext({ showWindow: true })); assert.deepEqual(scheduler.snapshot(), before);
  assert.throws(() => scheduler.enqueue(action('bad', 'happy', Infinity)));
});
