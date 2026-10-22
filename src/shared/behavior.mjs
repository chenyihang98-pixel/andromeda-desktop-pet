/** Passive action arbiter. Hosts call tick; this module never shows or focuses a window. */
export const BEHAVIOR_PRIORITY = Object.freeze({ idle: 10, routine: 20, notification: 40, task: 60, manual: 80, drag: 100 });
export const DEFAULT_COOLDOWNS = Object.freeze({ idle: 45_000, greet: 5000, happy: 2500, pet: 1500,
  notify: 5000, question: 3000, think: 2000, read: 2000, sleep: 30_000 });
const clone = value => JSON.parse(JSON.stringify(value));
function boundedNumber(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError('行为数值无效');
  return value;
}
function eventRecord(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('行为事件必须是普通对象');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('行为事件不能包含属性访问器');
  }
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,120}$/.test(value.id)
    || typeof value.action !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(value.action)
    || (value.kind !== undefined && (typeof value.kind !== 'string' || value.kind.length > 50))
    || (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 500))) throw new TypeError('行为事件无效');
  if (value.resumable !== undefined && typeof value.resumable !== 'boolean') throw new TypeError('恢复设置无效');
  return { id: value.id, kind: value.kind || 'action', action: value.action, text: value.text || '',
    priority: boundedNumber(value.priority ?? BEHAVIOR_PRIORITY.notification, 0, 100),
    durationMs: boundedNumber(value.durationMs ?? 1500, 1, 60_000), resumable: value.resumable !== false,
    ...(typeof value.taskId === 'string' && value.taskId.length <= 120 ? { taskId: value.taskId } : {}) };
}

export function createBehaviorScheduler({ now = Date.now, maxQueue = 32, cooldowns = {} } = {}) {
  if (typeof now !== 'function' || !Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 200
    || !cooldowns || Object.getPrototypeOf(cooldowns) !== Object.prototype) throw new TypeError('行为配置无效');
  const limits = { ...DEFAULT_COOLDOWNS };
  for (const [key, value] of Object.entries(cooldowns)) {
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(key)) throw new TypeError('动作名称无效');
    limits[key] = boundedNumber(value, 0, 86_400_000);
  }
  let queue = [], active = null, order = 0;
  const seen = new Set(), played = new Map();
  let context = { hidden: false, paused: false, dragging: false, reducedMotion: false };
  const clock = () => boundedNumber(now(), 0, 8_640_000_000_000_000);
  const suppressed = () => context.hidden || context.paused || context.dragging;
  function capture(time) {
    if (!active || active.suspended) return;
    active.remainingMs = Math.max(0, active.remainingMs - Math.max(0, time - active.updatedAt));
    active.updatedAt = Math.max(active.updatedAt, time);
  }
  function snapshot() {
    return { active: active ? clone({ ...active.event, remainingMs: active.remainingMs,
      static: context.reducedMotion, suspended: active.suspended }) : null,
    queue: queue.map(item => clone(item.event)), paused: Boolean(suppressed()), context: { ...context } };
  }
  function choose(time) {
    if (suppressed() || active) return;
    queue.sort((left, right) => right.event.priority - left.event.priority || left.order - right.order);
    const index = queue.findIndex(item => item.resuming || time - (played.get(item.event.action) ?? -Infinity) >= (limits[item.event.action] ?? 2000));
    if (index < 0) return;
    const item = queue.splice(index, 1)[0];
    active = { event: item.event, remainingMs: context.reducedMotion ? Math.min(900, item.remainingMs) : item.remainingMs,
      updatedAt: time, suspended: false };
    played.set(item.event.action, time);
  }
  function tick() {
    const time = clock();
    if (!suppressed()) {
      capture(time);
      if (active?.remainingMs === 0) active = null;
      choose(time);
    }
    return snapshot();
  }
  function enqueue(raw) {
    const entry = eventRecord(raw), time = clock();
    if (seen.has(entry.id)) return snapshot();
    seen.add(entry.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
    if (!suppressed()) capture(time);
    const supersedes = item => entry.taskId && item.taskId === entry.taskId && item.kind.split('.')[0] === entry.kind.split('.')[0];
    queue = queue.filter(item => !supersedes(item.event));
    if (active && supersedes(active.event)) active = null;
    if (active?.remainingMs === 0) active = null;
    const canStart = time - (played.get(entry.action) ?? -Infinity) >= (limits[entry.action] ?? 2000);
    if (active && entry.priority > active.event.priority && canStart && !suppressed()) {
      if (active.event.resumable && active.remainingMs > 0) queue.push({ event: active.event, remainingMs: active.remainingMs, order: ++order, resuming: true });
      active = null;
    }
    queue.push({ event: entry, remainingMs: entry.durationMs, order: ++order, resuming: false });
    queue.sort((left, right) => right.event.priority - left.event.priority || left.order - right.order);
    queue = queue.slice(0, maxQueue);
    choose(time);
    return snapshot();
  }
  function setContext(patch) {
    if (!patch || Object.getPrototypeOf(patch) !== Object.prototype) throw new TypeError('行为上下文无效');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(patch))) {
      if (!Object.hasOwn(context, key) || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') throw new TypeError('行为上下文无效');
    }
    const time = clock();
    capture(time);
    context = { ...context, ...patch };
    if (active) {
      active.suspended = Boolean(suppressed()); active.updatedAt = time;
      if (context.reducedMotion) active.remainingMs = Math.min(active.remainingMs, 900);
      if (active.remainingMs === 0) active = null;
    }
    if (!suppressed() && active && queue.some(item => item.event.priority > active.event.priority
      && (item.resuming || time - (played.get(item.event.action) ?? -Infinity) >= (limits[item.event.action] ?? 2000)))) {
      if (active.event.resumable) queue.push({ event: active.event, remainingMs: active.remainingMs, order: ++order, resuming: true });
      active = null;
    }
    choose(time);
    return snapshot();
  }
  function complete(id) {
    if (typeof id !== 'string') throw new TypeError('需要行为 ID');
    if (active?.event.id === id) { active = null; choose(clock()); }
    return snapshot();
  }
  function clear({ kind } = {}) {
    if (kind !== undefined && typeof kind !== 'string') throw new TypeError('行为类型无效');
    queue = kind === undefined ? [] : queue.filter(item => item.event.kind !== kind);
    if (active && (kind === undefined || active.event.kind === kind)) active = null;
    return snapshot();
  }
  // The host animates frames separately. Only action completion or an eligible
  // cooldown can change this queue without external input; no polling is needed.
  function nextDelay() {
    if (suppressed()) return null;
    const time = clock();
    if (active) return Math.max(1, active.remainingMs - Math.max(0, time - active.updatedAt));
    if (!queue.length) return null;
    return Math.max(1, Math.min(...queue.map(item => item.resuming ? 0
      : (played.get(item.event.action) ?? -Infinity) + (limits[item.event.action] ?? 2000) - time)));
  }
  return Object.freeze({ enqueue, tick, setContext, complete, clear, snapshot, nextDelay, isActive: () => active !== null });
}
