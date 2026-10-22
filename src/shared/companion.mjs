/** Platform-neutral companion domain. No timers, network, DOM or privileged APIs. */
export const COMPANION_VERSION = 1;
export const MAX_COMPANION_BYTES = 4 * 1024 * 1024;
export const COMPANION_ROLES = Object.freeze(['owner', 'visitor', 'admin']);
export const DEFAULT_PREFERENCES = Object.freeze({ motion: 'quiet', sound: false, reducedMotion: false,
  remindersMuted: false, routine: true, focusMinutes: 25, breakMinutes: 5,
  visualStyle: 'classic', theme: 'night', movement: 'off' });
export const LIMITS = Object.freeze({ todos: 200, memories: 200, notifications: 20, notificationItems: 20,
  tasks: 100, seenEvents: 500, text: 500, memoryText: 2000 });
const clone = value => JSON.parse(JSON.stringify(value));
const MINUTE = 60_000;
const TASK_STATES = ['working', 'waiting', 'completed', 'failed', 'cancelled'];
const FOCUS_STATES = ['idle', 'running', 'paused', 'completed', 'cancelled', 'break'];
const ACTIONS = { working: 'think', waiting: 'question', completed: 'happy', failed: 'question', cancelled: 'idle' };

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('需要普通对象');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('需要普通对象');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('不允许属性访问器');
  }
  return value;
}
function keys(value, allowed) {
  record(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('包含未知字段');
  return value;
}
function string(value, max = LIMITS.text, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(value)) {
    throw new TypeError('文本为空、过长或包含控制字符');
  }
  return value.trim();
}
function identifier(value) {
  const result = string(value, 120);
  if (!/^[a-zA-Z0-9_.:@-]+$/.test(result)) throw new TypeError('无效的标识');
  return result;
}
function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError('数值超出允许范围');
  }
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') throw new TypeError('需要布尔值'); return value; }
function timestamp(value) { return number(value, 0, 8_640_000_000_000_000, true); }
function nullableTime(value) { return value === null ? null : timestamp(value); }
function oneOf(value, values) { if (!values.includes(value)) throw new TypeError('不支持的选项'); return value; }
function attempt(callback, fallback) { try { return callback(); } catch { return fallback; } }
function array(value, limit, parse) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, limit).flatMap(item => {
    const clean = attempt(() => parse(record(item)), null);
    if (!clean || (clean.id && seen.has(clean.id))) return [];
    if (clean.id) seen.add(clean.id);
    return [clean];
  });
}
export function validatePreferencePatch(patch) {
  keys(patch, Object.keys(DEFAULT_PREFERENCES));
  if (!Object.keys(patch).length) throw new TypeError('设置不能为空');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key === 'motion' ? oneOf(value, ['still', 'quiet', 'lively'])
      : key === 'visualStyle' ? oneOf(value, ['classic', 'studio'])
      : key === 'theme' ? oneOf(value, ['night', 'dawn', 'festive'])
      : key === 'movement' ? oneOf(value, ['off', 'roam', 'follow', 'toss'])
      : key === 'focusMinutes' ? number(value, 1, 240, true)
      : key === 'breakMinutes' ? number(value, 1, 60, true) : boolean(value);
  }
  return result;
}
function preferences(value) {
  const result = { ...DEFAULT_PREFERENCES };
  if (!attempt(() => record(value), null)) return result;
  for (const key of Object.keys(result)) {
    if (Object.hasOwn(value, key)) Object.assign(result, attempt(() => validatePreferencePatch({ [key]: value[key] }), {}));
  }
  return result;
}
function emptyFocus(time) {
  return { id: null, status: 'idle', taskId: null, durationMs: 0, remainingMs: 0, breakMs: 5 * MINUTE,
    startedAt: null, updatedAt: time, creditedMs: 0, rewarded: false };
}
function defaults(role, time) {
  return { version: COMPANION_VERSION, scope: role,
    profile: { name: '星璇', ownerName: role === 'visitor' ? '访客' : '你', persona: '温和陪伴，表达清楚，尊重安静与休息。' },
    preferences: { ...DEFAULT_PREFERENCES }, focus: emptyFocus(time), todos: [],
    mood: { value: 0, updatedAt: time }, progression: { xp: 0, level: 1, focusSessions: 0, completedTodos: 0 },
    memories: [], notifications: [], tasks: [], seenEventIds: [],
    routine: { period: 'day', season: 'spring', updatedAt: time }, lastInteractionAt: null, lastTickAt: time };
}
function savedTodo(item) {
  return { id: identifier(item.id), text: string(item.text), dueAt: nullableTime(item.dueAt),
    status: oneOf(item.status, ['open', 'completed']), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
    completedAt: nullableTime(item.completedAt), remindedAt: nullableTime(item.remindedAt), rewarded: item.rewarded === true };
}
function savedMemory(item) {
  return { id: identifier(item.id), text: string(item.text, LIMITS.memoryText), source: string(item.source, 100),
    createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) };
}
function savedTask(item) {
  return { id: identifier(item.id), title: string(item.title, 200), status: oneOf(item.status, TASK_STATES),
    text: string(item.text, LIMITS.text, true), updatedAt: timestamp(item.updatedAt) };
}
function savedNotification(item) {
  const result = { id: identifier(item.id), kind: string(item.kind, 50), action: string(item.action, 50), text: string(item.text),
    priority: number(item.priority, 0, 100, true), count: number(item.count, 1, 1_000_000, true),
    createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
    items: array(item.items, LIMITS.notificationItems, entry => ({ id: identifier(entry.id), text: string(entry.text),
      ...(entry.taskId ? { taskId: identifier(entry.taskId) } : {}) })) };
  if (item.taskId) result.taskId = identifier(item.taskId);
  return result;
}
function restore(saved, role, time) {
  const result = defaults(role, time);
  if (!attempt(() => record(saved), null) || saved.version !== COMPANION_VERSION || saved.scope !== role) return result;
  const profile = attempt(() => record(saved.profile), {});
  for (const [key, max] of [['name', 40], ['ownerName', 40], ['persona', 1000]]) {
    result.profile[key] = attempt(() => string(profile[key], max), result.profile[key]);
  }
  result.preferences = preferences(saved.preferences);
  result.todos = array(saved.todos, LIMITS.todos, savedTodo);
  result.memories = array(saved.memories, LIMITS.memories, savedMemory);
  result.tasks = role === 'visitor' ? [] : array(saved.tasks, LIMITS.tasks, savedTask);
  result.notifications = array(saved.notifications, LIMITS.notifications, savedNotification);
  result.seenEventIds = Array.isArray(saved.seenEventIds) ? [...new Set(saved.seenEventIds.slice(-LIMITS.seenEvents)
    .flatMap(value => attempt(() => [identifier(value)], [])))] : [];
  const progress = attempt(() => record(saved.progression), {});
  result.progression.xp = attempt(() => number(progress.xp, 0, 1_000_000_000, true), 0);
  result.progression.level = Math.floor(Math.sqrt(result.progression.xp / 100)) + 1;
  for (const key of ['focusSessions', 'completedTodos']) result.progression[key] = attempt(() => number(progress[key], 0, 1_000_000, true), 0);
  const mood = attempt(() => record(saved.mood), {});
  result.mood.value = attempt(() => number(mood.value, -100, 100), 0);
  result.mood.updatedAt = Math.min(time, attempt(() => timestamp(mood.updatedAt), time));
  result.lastInteractionAt = attempt(() => nullableTime(saved.lastInteractionAt), null);
  result.focus = attempt(() => {
    const focus = record(saved.focus);
    if (focus.status === 'idle') return emptyFocus(time);
    const durationMs = number(focus.durationMs, MINUTE, 240 * MINUTE, true);
    const status = oneOf(focus.status, FOCUS_STATES);
    return { id: identifier(focus.id), status: status === 'running' || status === 'break' ? 'paused' : status,
      taskId: focus.taskId === null ? null : identifier(focus.taskId), durationMs,
      remainingMs: number(focus.remainingMs, 0, Math.max(durationMs, 60 * MINUTE), true),
      breakMs: number(focus.breakMs, MINUTE, 60 * MINUTE, true), startedAt: nullableTime(focus.startedAt), updatedAt: time,
      creditedMs: number(focus.creditedMs, 0, durationMs, true), rewarded: focus.rewarded === true,
      ...(focus.status === 'break' || focus.phase === 'break' ? { phase: 'break' } : {}) };
  }, emptyFocus(time));
  // Closed applications do not accrue focus, award XP, replay notifications, or penalize the pet.
  return result;
}

/** Preference files deliberately exclude identity, conversations, memories and tasks. */
export function exportPreferences(state) {
  return { schema: 'andromeda.preferences/v1', preferences: preferences(state?.preferences) };
}
export function exportMemories(state) {
  return { schema: 'andromeda.memories/v1', scope: state.scope, memories: clone(state.memories) };
}

export function createCompanionEngine(saved = {}, { now = Date.now, id, role = 'owner', timezoneOffsetMinutes = 0 } = {}) {
  oneOf(role, COMPANION_ROLES);
  number(timezoneOffsetMinutes, -840, 840, true);
  if (typeof now !== 'function' || (id !== undefined && typeof id !== 'function')) throw new TypeError('时钟与 ID 必须是函数');
  let serial = 0;
  const timeNow = () => timestamp(now());
  let state = restore(saved, role, timeNow());
  let emitted = [];
  let durableRevision = 0;
  const issuedIds = new Set();
  const nextId = prefix => {
    const occupied = new Set([state.focus.id, ...state.todos.map(item => item.id), ...state.memories.map(item => item.id),
      ...state.notifications.flatMap(item => [item.id, ...item.items.map(entry => entry.id)])]);
    for (let retry = 0; retry < 64; retry++) {
      const candidate = identifier(id ? id(prefix) : `${prefix}-${timeNow().toString(36)}-${(++serial).toString(36)}`);
      if (occupied.has(candidate) || issuedIds.has(candidate)) continue;
      issuedIds.add(candidate); if (issuedIds.size > 1024) issuedIds.delete(issuedIds.values().next().value);
      return candidate;
    }
    throw new Error('ID 生成器没有提供唯一标识');
  };
  function routineAt(time) {
    const date = new Date(time + timezoneOffsetMinutes * MINUTE), hour = date.getUTCHours(), month = date.getUTCMonth();
    return { period: hour < 6 || hour >= 22 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening',
      season: ['winter', 'spring', 'summer', 'autumn'][Math.floor(((month + 1) % 12) / 3)], updatedAt: time };
  }
  state.routine = routineAt(timeNow());
  function event(kind, action, text, priority = 40, taskId) {
    const entry = { id: nextId('event'), kind, action, text: text.slice(0, LIMITS.text), priority, ...(taskId ? { taskId } : {}) };
    emitted.push(entry);
    return entry;
  }
  function notify(kind, action, text, priority, taskId, time) {
    durableRevision++;
    text = text.slice(0, LIMITS.text);
    const item = { id: nextId('item'), text, ...(taskId ? { taskId } : {}) };
    const current = state.notifications.find(entry => entry.kind === kind && entry.action === action);
    if (current) {
      current.count = Math.min(1_000_000, current.count + 1); current.updatedAt = time;
      current.text = text; current.priority = Math.max(current.priority, priority);
      current.items.push(item); current.items = current.items.slice(-LIMITS.notificationItems);
      // A merged card may contain several tasks; only individual items retain their target.
      if (current.taskId !== taskId) delete current.taskId;
    } else {
      state.notifications.push({ id: nextId('notification'), kind, action, text, priority, count: 1,
        createdAt: time, updatedAt: time, ...(taskId ? { taskId } : {}), items: [item] });
      state.notifications = state.notifications.slice(-LIMITS.notifications);
    }
    if (!state.preferences.remindersMuted) event(kind, action, text, priority, taskId);
  }
  function reward(amount) {
    state.progression.xp = Math.min(1_000_000_000, state.progression.xp + amount);
    state.progression.level = Math.floor(Math.sqrt(state.progression.xp / 100)) + 1;
  }
  function mood(delta, time) { state.mood.value = Math.max(-100, Math.min(100, state.mood.value + delta)); state.mood.updatedAt = time; }
  function finishFocus(time) {
    const focus = state.focus;
    if (!['running', 'paused'].includes(focus.status) || focus.phase === 'break') return false;
    focus.status = 'completed'; focus.updatedAt = time;
    if (!focus.rewarded) {
      const minutes = Math.floor(focus.creditedMs / MINUTE);
      if (minutes > 0) { reward(Math.min(120, minutes * 2)); state.progression.focusSessions++; }
      focus.rewarded = true;
    }
    mood(12, time);
    notify('focus.completed', 'happy', '这一段专注完成了，休息一下吧。', 60, focus.taskId, time);
    return true;
  }
  function advance(time) {
    const decay = Math.max(0, time - state.mood.updatedAt) / (30 * MINUTE);
    state.mood.value = Math.sign(state.mood.value) * Math.max(0, Math.abs(state.mood.value) - decay);
    state.mood.updatedAt = Math.max(state.mood.updatedAt, time);
    const focus = state.focus;
    if (focus.status === 'running' || focus.status === 'break') {
      const elapsed = Math.min(focus.remainingMs, Math.max(0, time - focus.updatedAt));
      focus.remainingMs -= elapsed;
      if (focus.status === 'running') focus.creditedMs = Math.min(focus.durationMs, focus.creditedMs + elapsed);
      focus.updatedAt = Math.max(focus.updatedAt, time);
      if (focus.remainingMs === 0) {
        if (focus.status === 'running') finishFocus(time);
        else { focus.status = 'idle'; focus.phase = 'break'; notify('focus.break-completed', 'greet', '休息结束，可以按自己的节奏继续。', 40, null, time); }
      }
    }
    for (const todo of state.todos) {
      if (todo.status === 'open' && todo.dueAt !== null && todo.dueAt <= time && todo.remindedAt !== todo.dueAt) {
        todo.remindedAt = todo.dueAt;
        notify('todo.due', 'notify', todo.text, 60, todo.id, time);
      }
    }
    if (state.preferences.routine) {
      // UTC by default; each host supplies its explicit current timezone offset.
      const routine = routineAt(time);
      if (routine.period !== state.routine.period && !state.preferences.remindersMuted) {
        event('routine.changed', routine.period === 'night' ? 'sleep' : routine.period === 'morning' ? 'greet' : 'idle',
          { night: '夜深了，可以让自己休息一下。', morning: '早上好，按自己的节奏开始吧。', day: '星璇安静地陪着你。', evening: '忙碌了一天，记得放松一下。' }[routine.period], 20);
      }
      state.routine = routine;
    }
    state.lastTickAt = Math.max(state.lastTickAt, time);
  }
  function findTodo(value) {
    const todo = state.todos.find(item => item.id === identifier(value));
    if (!todo) throw new RangeError('待办不存在');
    return todo;
  }
  const commandKeys = {
    'profile.update': ['patch'], 'preferences.update': ['patch'], 'preferences.import': ['data'], 'preferences.export': [],
    'focus.start': ['taskId', 'durationMinutes', 'breakMinutes'], 'focus.pause': [], 'focus.resume': [],
    'focus.cancel': [], 'focus.finish': [], 'focus.break': ['minutes'],
    'todo.add': ['text', 'dueAt'], 'todo.update': ['id', 'patch'], 'todo.complete': ['id'], 'todo.delete': ['id'], 'todo.snooze': ['id', 'minutes'],
    'memory.add': ['text', 'source'], 'memory.update': ['id', 'text'], 'memory.forget': ['id'], 'memory.clear': [], 'memory.export': [],
    'notification.ack': ['id'], 'notification.clear': [], 'reminders.mute': ['muted'], 'interaction': ['kind'],
    'task.event': ['eventId', 'taskId', 'status', 'text', 'title'],
  };
  function dispatch(command) {
    record(command);
    if (!Object.hasOwn(commandKeys, command.type)) throw new TypeError('不支持的命令');
    keys(command, ['type', ...commandKeys[command.type]]);
    // Read-only exports must not consume due reminders that a host would then discard.
    if (command.type === 'preferences.export' || command.type === 'memory.export') {
      return { state: clone(state), events: [], data: command.type === 'preferences.export' ? exportPreferences(state) : exportMemories(state) };
    }
    const previous = clone(state), previousRevision = durableRevision;
    emitted = [];
    try {
      const time = timeNow();
      advance(time);
      const focus = state.focus;
      switch (command.type) {
        case 'profile.update': {
          keys(command.patch, ['name', 'ownerName', 'persona']);
          if (!Object.keys(command.patch).length) throw new TypeError('身份设置不能为空');
          for (const [key, value] of Object.entries(command.patch)) state.profile[key] = string(value, key === 'persona' ? 1000 : 40);
          break;
        }
        case 'preferences.update': Object.assign(state.preferences, validatePreferencePatch(command.patch)); break;
        case 'preferences.import':
          keys(command.data, ['schema', 'preferences']);
          if (command.data.schema !== 'andromeda.preferences/v1') throw new TypeError('不支持的偏好格式');
          Object.assign(state.preferences, validatePreferencePatch(command.data.preferences)); break;
        case 'focus.start': {
          if (['running', 'paused', 'break'].includes(focus.status)) throw new Error('请先结束或取消当前计时');
          const duration = number(command.durationMinutes ?? state.preferences.focusMinutes, 1, 240, true) * MINUTE;
          const breakMs = number(command.breakMinutes ?? state.preferences.breakMinutes, 1, 60, true) * MINUTE;
          const taskId = command.taskId === undefined ? null : findTodo(command.taskId).id;
          if (taskId && findTodo(taskId).status !== 'open') throw new Error('已完成待办不能开始专注');
          state.focus = { id: nextId('focus'), status: 'running', taskId, durationMs: duration, remainingMs: duration,
            breakMs, startedAt: time, updatedAt: time, creditedMs: 0, rewarded: false };
          event('focus.started', 'think', '我们一起专注一会儿。', 50, taskId); break;
        }
        case 'focus.pause':
          if (focus.status === 'running' || focus.status === 'break') { focus.phase = focus.status === 'break' ? 'break' : 'focus'; focus.status = 'paused'; focus.updatedAt = time; }
          break;
        case 'focus.resume':
          if (focus.status === 'paused') { focus.status = focus.phase === 'break' ? 'break' : 'running'; focus.updatedAt = time; event('focus.resumed', 'think', '从刚才的地方继续。', 50, focus.taskId); }
          break;
        case 'focus.cancel':
          if (['running', 'paused', 'break'].includes(focus.status)) { focus.status = 'cancelled'; focus.updatedAt = time; event('focus.cancelled', 'idle', '已停止计时，随时可以重新开始。', 40); }
          break;
        case 'focus.finish': finishFocus(time); break;
        case 'focus.break':
          if (focus.status !== 'completed') throw new Error('完成专注后才能开始休息');
          focus.remainingMs = number(command.minutes ?? focus.breakMs / MINUTE, 1, 60, true) * MINUTE;
          focus.status = 'break'; focus.phase = 'break'; focus.updatedAt = time;
          event('focus.break-started', 'sleep', '休息一下，星璇在这里等你。', 40); break;
        case 'todo.add':
          if (state.todos.length >= LIMITS.todos) throw new RangeError('待办数量已达上限');
          state.todos.push({ id: nextId('todo'), text: string(command.text), dueAt: command.dueAt === undefined ? null : nullableTime(command.dueAt),
            status: 'open', createdAt: time, updatedAt: time, completedAt: null, remindedAt: null, rewarded: false }); break;
        case 'todo.update': {
          const todo = findTodo(command.id); keys(command.patch, ['text', 'dueAt']);
          if (!Object.keys(command.patch).length) throw new TypeError('待办修改不能为空');
          if (Object.hasOwn(command.patch, 'text')) todo.text = string(command.patch.text);
          if (Object.hasOwn(command.patch, 'dueAt')) { const dueAt = nullableTime(command.patch.dueAt); if (todo.dueAt !== dueAt) todo.remindedAt = null; todo.dueAt = dueAt; }
          todo.updatedAt = time; break;
        }
        case 'todo.complete': {
          const todo = findTodo(command.id);
          if (todo.status !== 'completed') {
            todo.status = 'completed'; todo.completedAt = time; todo.updatedAt = time;
            if (!todo.rewarded) { reward(10); state.progression.completedTodos++; todo.rewarded = true; }
            mood(8, time); notify('todo.completed', 'happy', `完成了：${todo.text}`, 60, todo.id, time);
          }
          break;
        }
        case 'todo.delete': {
          const todo = findTodo(command.id); state.todos = state.todos.filter(item => item.id !== todo.id);
          if (focus.taskId === todo.id) focus.taskId = null; break;
        }
        case 'todo.snooze': {
          const todo = findTodo(command.id);
          if (todo.status !== 'open') throw new Error('已完成待办不能稍后提醒');
          todo.dueAt = time + number(command.minutes, 1, 10080, true) * MINUTE;
          todo.remindedAt = null; todo.updatedAt = time; break;
        }
        case 'memory.add':
          if (state.memories.length >= LIMITS.memories) throw new RangeError('记忆数量已达上限');
          state.memories.push({ id: nextId('memory'), text: string(command.text, LIMITS.memoryText),
            source: string(command.source ?? 'user', 100), createdAt: time, updatedAt: time }); break;
        case 'memory.update': {
          const memory = state.memories.find(item => item.id === identifier(command.id));
          if (!memory) throw new RangeError('记忆不存在');
          memory.text = string(command.text, LIMITS.memoryText); memory.updatedAt = time; break;
        }
        case 'memory.forget': { const memoryId = identifier(command.id); state.memories = state.memories.filter(item => item.id !== memoryId); break; }
        case 'memory.clear': state.memories = []; break;
        case 'notification.ack': { const notificationId = identifier(command.id); state.notifications = state.notifications.filter(item => item.id !== notificationId); break; }
        case 'notification.clear': state.notifications = []; break;
        case 'reminders.mute': state.preferences.remindersMuted = boolean(command.muted); break;
        case 'interaction': {
          const kind = oneOf(command.kind, ['greet', 'pet', 'play', 'thanks']);
          const messages = { greet: `你好，${state.profile.ownerName}。`, pet: '收到你的摸摸啦。', play: '陪你放松一下。', thanks: '能帮上忙就好。' };
          // Repeated clicks are feedback, never an unlimited XP faucet.
          if (state.lastInteractionAt === null || time - state.lastInteractionAt >= MINUTE) { mood(4, time); reward(1); state.lastInteractionAt = time; }
          event(`interaction.${kind}`, kind === 'greet' ? 'greet' : kind === 'pet' ? 'pet' : 'happy', messages[kind], 80); break;
        }
        case 'task.event': {
          if (role === 'visitor') throw new Error('访客不能注入私人任务事件');
          const eventId = identifier(command.eventId), taskId = identifier(command.taskId), status = oneOf(command.status, TASK_STATES);
          let task = state.tasks.find(item => item.id === taskId);
          const text = string(command.text ?? '', LIMITS.text, true), title = string(command.title ?? task?.title ?? taskId, 200);
          if (state.seenEventIds.includes(eventId)) break;
          state.seenEventIds.push(eventId); state.seenEventIds = state.seenEventIds.slice(-LIMITS.seenEvents);
          if (task?.status === status && task.text === text && task.title === title) break;
          if (!task) { task = { id: taskId }; state.tasks.push(task); state.tasks = state.tasks.slice(-LIMITS.tasks); }
          Object.assign(task, { status, title, text, updatedAt: time });
          const message = text || ({ working: '正在处理', waiting: '需要你看一下', completed: '已经完成', failed: '暂时未完成', cancelled: '已取消' }[status] + `：${title}`);
          if (['completed', 'failed', 'waiting'].includes(status)) notify(`task.${status}`, ACTIONS[status], message, status === 'failed' ? 70 : 60, taskId, time);
          else event(`task.${status}`, ACTIONS[status], message, status === 'working' ? 50 : 30, taskId);
          if (status === 'completed') mood(6, time);
          break;
        }
      }
      // New reminders due immediately are detected on this dispatch, without waiting for a host interval.
      advance(time);
      durableRevision++;
      return { state: clone(state), events: clone(emitted) };
    } catch (error) { state = previous; durableRevision = previousRevision; emitted = []; throw error; }
  }
  function tick() { emitted = []; advance(timeNow()); return { state: clone(state), events: clone(emitted) }; }
  function serialize() {
    const result = clone(state), time = timeNow(), focus = result.focus;
    // Capture remaining time without emitting/discarding events; running focus restores paused.
    if (focus.status === 'running' || focus.status === 'break') {
      const elapsed = Math.min(focus.remainingMs, Math.max(0, time - focus.updatedAt));
      focus.remainingMs -= elapsed; if (focus.status === 'running') focus.creditedMs = Math.min(focus.durationMs, focus.creditedMs + elapsed);
      focus.updatedAt = Math.max(time, focus.updatedAt);
    }
    return result;
  }
  /** Small, detached rendering projection. Never traverses private lists or conversations. */
  function publicSnapshot() {
    return {preferences: {...state.preferences}, mood: state.mood.value, routine: {...state.routine},
      focusing: state.focus.status === 'running', level: state.progression.level};
  }
  /** Earliest domain deadline; hosts own timers and may add persistence checkpoints. */
  function nextWakeAt() {
    const time = timeNow(), candidates = [], focus = state.focus;
    if (focus.status === 'running' || focus.status === 'break') candidates.push(focus.updatedAt + focus.remainingMs);
    for (const todo of state.todos) if (todo.status === 'open' && todo.dueAt !== null && todo.remindedAt !== todo.dueAt) candidates.push(todo.dueAt);
    if (state.mood.value !== 0) candidates.push(state.mood.updatedAt + Math.min(30_000, Math.ceil(Math.abs(state.mood.value) * 30 * MINUTE)));
    if (state.preferences.routine) {
      const current = routineAt(time);
      if (current.period !== state.routine.period || current.season !== state.routine.season) candidates.push(time);
      const offset = timezoneOffsetMinutes * MINUTE, day = 24 * 60 * MINUTE;
      const dayStart = Math.floor((time + offset) / day) * day - offset;
      // Midnight also updates season without assuming that every day is a period boundary.
      for (const hour of [6, 12, 18, 22, 24]) {
        const boundary = dayStart + hour * 60 * MINUTE;
        if (boundary > time) {candidates.push(boundary);break;}
      }
    }
    return candidates.length ? Math.max(time, Math.min(...candidates)) : null;
  }
  return Object.freeze({ dispatch, tick, snapshot: () => clone(state), serialize, publicSnapshot, nextWakeAt,
    revision: () => durableRevision });
}
