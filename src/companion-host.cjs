'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createAssistantService} = require('./services/assistant.cjs');

// The host owns private state. Renderers receive bounded commands, never paths or credentials.
function createCompanionHost({directory, safeStorage, publish, emit, capture, openLink, assistantFetch,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let engine, assistant, timer, persistenceError = null, stopped = false, bridge, makeEngine, validateBackup;
  let focusActive = false, savedRevision = 0, savedAt = 0;
  let maximumBytes;
  const assistantOperations = new Map(), assistantTerminal = new Set();
  const filename = path.join(directory, 'companion-v1.json');
  function checkRunning() { if (stopped) throw new Error('陪伴服务已停止'); }
  function atomicWrite(target, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error('陪伴存档超过 4 MiB，请整理记录后重试。');
    const temporary = target + '.' + randomUUID() + '.tmp';let fd;
    try {
      fs.mkdirSync(directory, {recursive: true});
      fd = fs.openSync(temporary, 'wx', 0o600);fs.writeFileSync(fd, text);fs.fsyncSync(fd);fs.closeSync(fd);fd = undefined;
      fs.renameSync(temporary, target);
    } catch (error) {if (fd !== undefined) try {fs.closeSync(fd);} catch {}try {fs.unlinkSync(temporary);} catch {}throw error;}
  }
  function save() {
    if (!engine) return;
    savedAt = now(); // A failed disk must not turn an overdue checkpoint into a busy retry loop.
    try {
      atomicWrite(filename, engine.serialize());persistenceError = null;savedRevision = engine.revision();savedAt = now();
    } catch {persistenceError = '陪伴记录暂时无法保存，请导出备份并检查磁盘。';}
  }
  function snapshot() { return {companion: engine?.serialize() || null, assistant: assistant?.snapshot() || null, persistenceError}; }
  function scheduleWake() {
    clearTimer(timer);timer = null;
    if (stopped || !engine) return;
    const domainDeadline = engine.nextWakeAt(), checkpoint = focusActive ? savedAt + 15_000 : null;
    const retry = persistenceError && engine.revision() !== savedRevision ? savedAt + 30_000 : null;
    const deadlines = [domainDeadline, checkpoint, retry].filter(value => value !== null);
    if (!deadlines.length) return;
    const deadline = Math.min(...deadlines);
    timer = setTimer(() => {
      timer = null;if (stopped) return;
      if (now() < deadline) {scheduleWake();return;}
      const result = engine.tick();
      update(result, engine.revision() !== savedRevision || (focusActive && now() - savedAt >= 15_000));
    }, Math.max(1, Math.min(2_147_483_647, deadline - now())));
    timer?.unref?.();
  }
  function update(result, persist = true) {
    focusActive = ['running', 'break'].includes(result.state.focus.status);
    if (persist) save();
    for (const event of result.events) emit(event);
    // tick/dispatch already produced a detached state: do not clone it or the assistant history again.
    publish({companion: result.state, persistenceError});scheduleWake();return {...result, persistenceError};
  }
  function assistantEvent(event) {
    if (stopped) return;
    publish({assistantEvent: event});
    const requestId = event.requestId;
    if (!requestId) return;
    let stage, kind = event.kind || assistantOperations.get(requestId);
    if (event.type === 'assistant:status' && ['chat', 'transcribe', 'synthesize', 'capture', 'tool'].includes(event.status)) {
      stage = 'working';kind = event.status;assistantOperations.set(requestId, kind);
    } else if (event.type === 'assistant:result') stage = 'result';
    else if (event.type === 'assistant:error') stage = event.code === 'CANCELLED' ? 'cancelled' : 'error';
    else if (event.type === 'assistant:status' && event.status === 'idle' && assistantOperations.has(requestId)) stage = 'cancelled';
    if (!stage || assistantTerminal.has(requestId)) return;
    if (stage !== 'working') {
      assistantOperations.delete(requestId);assistantTerminal.add(requestId);
      if (assistantTerminal.size > 256) assistantTerminal.delete(assistantTerminal.values().next().value);
    }
    const messages = {chat: ['正在整理回答。', '回答准备好了。'], transcribe: ['正在转写这段录音。', '文字已转写好，请检查后发送。'],
      synthesize: ['正在准备声音。', '声音准备好了。'], capture: ['正在准备本次屏幕预览。', '预览已准备好，由你决定是否发送。'], tool: ['正在执行已确认的操作。', '操作已完成。']};
    const text = stage === 'working' ? messages[kind]?.[0] || '正在处理。' : stage === 'result' ? messages[kind]?.[1] || '已完成。'
      : stage === 'cancelled' ? '本次已停止。' : '这次没有完成，可以在陪伴空间查看并重试。';
    // Same family/task supersedes working; distinct event IDs avoid accidental dedupe of completion.
    emit({id: 'assistant-' + randomUUID(), requestId, taskId: 'assistant:' + requestId, kind: 'assistant.activity', stage,
      action: stage === 'working' ? 'think' : stage === 'error' ? 'question' : stage === 'cancelled' ? 'idle' : 'greet',
      text, priority: stage === 'error' ? 45 : 40, resumable: false});
  }
  const ready = (async () => {
    const [{createCompanionEngine, MAX_COMPANION_BYTES}, {validateCompanionBackup}] = await Promise.all([import('./shared/companion.mjs'), import('./backup.mjs')]);
    maximumBytes = MAX_COMPANION_BYTES;
    makeEngine = saved => createCompanionEngine(saved, {now, role: 'owner', id: prefix => `${prefix}-${randomUUID()}`, timezoneOffsetMinutes: -new Date(now()).getTimezoneOffset()});
    validateBackup = validateCompanionBackup;
    let saved = {};
    try { if (fs.statSync(filename).size <= maximumBytes) saved = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch {}
    engine = makeEngine(saved);
    savedRevision = engine.revision();savedAt = now();
    assistant = createAssistantService({directory, safeStorage, capture, fetchImpl: assistantFetch,
      toolHandlers: {
        openWebsite: {label: '打开星匠网站', parameters: {type: 'object', properties: {}, additionalProperties: false},
          validate: args => args && Object.keys(args).length === 0, run: () => {checkRunning();return openLink('home');}},
        addTodo: {label: '添加本地待办', validate: args => args && Object.keys(args).length === 1 && typeof args.text === 'string' && args.text.trim().length > 0 && args.text.length <= 500,
          parameters: {type: 'object', properties: {text: {type: 'string', minLength: 1, maxLength: 500}}, required: ['text'], additionalProperties: false},
          run: args => {checkRunning();return update(engine.dispatch({type: 'todo.add', text: args.text})).state.todos.slice(-1)[0];}},
      },
      onEvent: assistantEvent,
    });
    await assistant.load();
    if (!stopped && assistant.snapshot().persona !== engine.snapshot().profile.persona) await assistant.configure({persona: engine.snapshot().profile.persona});
    if (!stopped) {
      const initial = snapshot();focusActive = ['running', 'break'].includes(initial.companion.focus.status);
      scheduleWake();publish(initial);
    }
  })();
  return {
    ready,
    publicState() { return engine?.publicSnapshot() || null; },
    cancelAssistant() { assistant?.cancel(); },
    async state() { await ready; return snapshot(); },
    async dispatch(command) {
      await ready;checkRunning();const result = update(engine.dispatch(command));
      if (command.type === 'profile.update' && assistant.snapshot().persona !== result.state.profile.persona) {
        await assistant.configure({persona: result.state.profile.persona});if (!stopped) publish({assistant: assistant.snapshot()});
      }
      return result;
    },
    async assistantCall({method, payload}) {
      await ready;
      checkRunning();
      if (!['configure', 'chat', 'transcribe', 'synthesize', 'captureOnce', 'confirmTool', 'proposeTool', 'cancel', 'clearHistory'].includes(method)) throw new TypeError('不支持的智能操作');
      if (method === 'configure') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('智能服务设置无效');
        payload = {...payload, persona: engine.snapshot().profile.persona};
      }
      try {return await assistant[method](payload);}
      finally {if (!stopped) publish({assistant: assistant.snapshot()});}
    },
    async exportData(kind) {
      await ready;
      if (kind === 'preferences') return engine.dispatch({type: 'preferences.export'}).data;
      if (kind === 'memories') return engine.dispatch({type: 'memory.export'}).data;
      if (kind === 'backup') return {schema: 'andromeda.backup/v1', companion: engine.serialize()};
      throw new TypeError('不支持的导出类型');
    },
    async previewRestore(value) {await ready;checkRunning();return validateBackup(value).summary;},
    async restoreBackup(value) {
      await ready;checkRunning();
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.confirmed !== true
        || Object.keys(value).some(key => !['backup', 'confirmed'].includes(key))) throw new TypeError('请先查看备份预览并明确确认恢复。');
      const {state: restored, summary} = validateBackup(value.backup), nextEngine = makeEngine(restored);
      const backupFile = `companion-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
      try {
        // These synchronous writes cannot interleave with ticks, commands or bridge callbacks.
        // The in-memory engine changes only after both durable renames succeed.
        atomicWrite(path.join(directory, backupFile), {schema: 'andromeda.backup/v1', companion: engine.serialize()});
        atomicWrite(filename, nextEngine.serialize());
      } catch {
        persistenceError = '恢复未完成，当前记录保持不变。请检查磁盘空间和配置目录权限。';publish(snapshot());
        throw new Error(persistenceError);
      }
      engine = nextEngine;persistenceError = null;focusActive = false;savedRevision = engine.revision();savedAt = now();assistant.cancel();scheduleWake();
      if (assistant.snapshot().persona !== restored.profile.persona) await assistant.configure({persona: restored.profile.persona});
      const result = {...snapshot(), summary, backupFile};if (!stopped) publish({companion: result.companion, assistant: result.assistant, persistenceError});return result;
    },
    async taskBridge(enabled) {
      await ready;
      checkRunning();
      if (typeof enabled !== 'boolean') throw new TypeError('无效的任务桥设置');
      bridge ||= require('./services/task-bridge.cjs').createTaskBridge({onEvent: command => {checkRunning();return update(engine.dispatch(command));}});
      if (enabled) await bridge.start(); else await bridge.stop();
      if (stopped) {await bridge.stop();checkRunning();}
      const result = bridge.snapshot(); return {...result, enabled: result.running};
    },
    async refresh() {await ready;checkRunning();return update(engine.tick(), engine.revision() !== savedRevision);},
    pause() {if (stopped) return;assistant?.cancel();if (engine && focusActive) update(engine.dispatch({type: 'focus.pause'}));},
    stop() {if (stopped) return;stopped = true;clearTimer(timer);timer = null;assistant?.cancel();if (engine && (focusActive || engine.revision() !== savedRevision)) save();return bridge?.stop().catch(() => {});},
  };
}
module.exports = {createCompanionHost};
