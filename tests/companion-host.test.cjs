'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createCompanionHost } = require('../src/companion-host.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(t, options = {}) {
  const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'andromeda-host-test-'));
  const publications = [], events = [];
  const host = createCompanionHost({ directory, publish: value => publications.push(value), emit: event => events.push(event),
    capture: async () => { throw new Error('test must not capture'); }, openLink: async () => true, ...options });
  t.after(async () => {
    await host.ready.catch(() => {});
    await host.taskBridge(false).catch(() => {});
    await host.stop();
    // Resolve/validate our exact owned temporary directory before recursive cleanup.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('andromeda-host-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, host, publications, events };
}
function sendTask(bridge, body, token = bridge.token) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(bridge.url, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': bytes.length,
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.setTimeout(3000, () => request.destroy(new Error('local test request timed out')));
    request.end(bytes);
  });
}

function controlledClock() {
  let time = Date.UTC(2026, 9, 22, 3), serial = 0;
  const pending = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => {const id = ++serial;pending.set(id, {at: time + delay, callback});return id;},
    clearTimer: id => pending.delete(id),
    get pending() {return pending.size;},
    advance(milliseconds) {
      const target = time + milliseconds;let limit = 1000;
      while (--limit) {
        const next = [...pending].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;time = next[1].at;pending.delete(next[0]);next[1].callback();
      }
      assert.ok(limit, 'scheduler must not busy loop');time = target;
    },
  };
}

test('deadline scheduler checkpoints active focus, saves muted due cards and has no idle heartbeat', async t => {
  const clock = controlledClock(), {host, directory, publications, events} = await fixture(t, clock);await host.ready;
  await host.dispatch({type: 'preferences.update', patch: {routine: false, remindersMuted: true}});
  assert.equal(clock.pending, 0);const idleCount = publications.length;clock.advance(60_000);assert.equal(publications.length, idleCount);
  await host.dispatch({type: 'todo.add', text: 'silent due', dueAt: clock.now() + 5000});
  clock.advance(5000);
  let saved = JSON.parse(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'));
  assert.equal(saved.notifications.length, 1);assert.equal(events.filter(event => event.kind === 'todo.due').length, 0);
  await host.dispatch({type: 'focus.start', durationMinutes: 1});
  const focusCount = publications.length;clock.advance(14_000);assert.equal(publications.length, focusCount);
  clock.advance(1000);saved = JSON.parse(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'));assert.equal(saved.focus.remainingMs, 45_000);
  clock.advance(45_000);const completed = (await host.state()).companion;assert.equal(completed.focus.status, 'completed');assert.equal(completed.progression.xp, 2);
  saved = JSON.parse(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'));assert.equal(saved.focus.status, 'completed');assert.equal(saved.progression.xp, 2);
  clock.advance(60_000);assert.equal((await host.state()).companion.progression.xp, 2);
  host.stop();assert.equal(clock.pending, 0);const stoppedCount = publications.length;clock.advance(3_600_000);assert.equal(publications.length, stoppedCount);
});

test('failed persistence schedules a bounded retry and recovers without an idle busy loop', async t => {
  const clock = controlledClock(), {host, directory, publications} = await fixture(t, clock);await host.ready;
  await host.dispatch({type: 'preferences.update', patch: {routine: false}});
  const filename = path.join(directory, 'companion-v1.json');
  await fs.unlink(filename);await fs.mkdir(filename);
  const result = await host.dispatch({type: 'memory.add', text: 'must survive failed write'});
  assert.ok(result.persistenceError);assert.equal(clock.pending, 1);
  const before = publications.length;clock.advance(29_999);assert.equal(publications.length, before);
  clock.advance(1);assert.equal(publications.length, before + 1);assert.equal(clock.pending, 1);
  await fs.rmdir(filename);clock.advance(30_000);
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));assert.equal(saved.memories[0].text, 'must survive failed write');
  assert.equal((await host.state()).persistenceError, null);assert.equal(clock.pending, 0);
});

test('real host loads the ESM domain, persists commands and exports without assistant credentials', async t => {
  const { host, directory } = await fixture(t); await host.ready;
  assert.equal((await host.state()).companion.scope, 'owner');
  await host.dispatch({ type: 'todo.add', text: 'review report' });
  await host.dispatch({ type: 'memory.add', text: '私人偏好', source: 'user-confirmed' });
  const secret = 'unit-test-secret-never-export-57492';
  await host.assistantCall({ method: 'configure', payload: { enabled: true, endpoint: 'https://assistant.example/v1', model: 'test-model', apiKey: secret } });
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'));
  assert.equal(saved.todos[0].text, 'review report');
  assert.equal(saved.memories[0].source, 'user-confirmed');
  for (const kind of ['preferences', 'memories', 'backup']) {
    const exported = await host.exportData(kind);
    assert.equal(JSON.stringify(exported).includes(secret), false);
    if (kind === 'preferences') { assert.equal(exported.profile, undefined); assert.equal(exported.memories, undefined); }
    if (kind === 'memories') assert.equal(exported.memories[0].text, '私人偏好');
  }
  assert.equal(JSON.stringify(await host.state()).includes(secret), false);
  assert.equal((await fs.readFile(path.join(directory, 'assistant.json'), 'utf8')).includes(secret), false);
});

test('invalid host commands reject without changing the persisted state', async t => {
  const { host, directory } = await fixture(t); await host.ready;
  await host.dispatch({ type: 'todo.add', text: 'valid' });
  const before = await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8');
  await assert.rejects(host.dispatch({ type: 'todo.add', text: '' }));
  await assert.rejects(host.dispatch({ type: 'execute', command: 'anything' }));
  await assert.rejects(host.assistantCall({ method: 'readFile', payload: {} }));
  await assert.rejects(host.exportData('apiKey'));
  assert.equal(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'), before);
});

test('publicState exposes only rendering preferences and coarse companion state', async t => {
  const { host } = await fixture(t); await host.ready;
  await host.dispatch({ type: 'profile.update', patch: { ownerName: 'private-owner', persona: 'private-persona' } });
  await host.dispatch({ type: 'memory.add', text: 'private-memory' });
  await host.dispatch({ type: 'todo.add', text: 'private-todo' });
  await host.dispatch({ type: 'task.event', eventId: 'private-event', taskId: 'private-job', title: 'private-task', status: 'working' });
  const publicState = host.publicState();
  assert.deepEqual(Object.keys(publicState).sort(), ['focusing', 'level', 'mood', 'preferences', 'routine']);
  assert.equal(JSON.stringify(publicState).includes('private-'), false);
  publicState.preferences.motion = 'still';
  assert.equal((await host.state()).companion.preferences.motion, 'quiet');
});

test('saving a running focus and reopening the host restores paused without offline XP', async t => {
  const first = await fixture(t); await first.host.ready;
  await first.host.dispatch({ type: 'focus.start', durationMinutes: 1 });
  first.host.stop();
  const saved = JSON.parse(await fs.readFile(path.join(first.directory, 'companion-v1.json'), 'utf8'));
  assert.equal(saved.focus.status, 'running');
  const second = createCompanionHost({ directory: first.directory, publish: () => {}, emit: () => {}, capture: async () => null, openLink: async () => true });
  try {
    await second.ready;
    const restored = (await second.state()).companion;
    assert.equal(restored.focus.status, 'paused'); assert.equal(restored.progression.xp, 0);
    assert.ok(restored.focus.remainingMs <= 60_000 && restored.focus.remainingMs > 55_000);
  } finally { second.stop(); }
});

test('idle host has no heartbeat publication; a real deadline wakes once and stop cancels future work', async t => {
  const { host, publications, events } = await fixture(t); await host.ready;
  await host.dispatch({type: 'preferences.update', patch: {routine: false}});
  const start = publications.length;await delay(150);assert.equal(publications.length, start);
  await host.dispatch({type: 'todo.add', text: 'real deadline', dueAt: Date.now() + 100});
  await delay(250);assert.equal(events.filter(event => event.kind === 'todo.due').length, 1);
  await host.dispatch({type: 'todo.add', text: 'cancelled timer', dueAt: Date.now() + 100});
  host.stop();const stopped = publications.length;await delay(200);assert.equal(publications.length, stopped);
});

test('stop before asynchronous ready cannot create a late timer', async t => {
  const created = [];
  const {host} = await fixture(t, {setTimer: (...args) => {created.push(args);return 1;}, clearTimer: () => {}});
  host.stop();await host.ready;assert.equal(created.length, 0);
});

test('task bridge defaults off, accepts authenticated status only and rotates tokens after stop/start', async t => {
  const { host } = await fixture(t); await host.ready;
  const disabled = await host.taskBridge(false);
  assert.equal(disabled.running, false); assert.equal(disabled.enabled, false); assert.equal(disabled.token, null); assert.equal(disabled.url, null);
  const first = await host.taskBridge(true); assert.equal(first.host, '127.0.0.1'); assert.equal(first.enabled, true);
  const body = { eventId: 'build-1', taskId: 'build', status: 'completed', title: '构建' };
  assert.equal((await sendTask(first, body)).status, 202);
  assert.equal((await host.state()).companion.tasks[0].status, 'completed');
  assert.equal(JSON.stringify(host.publicState()).includes(first.token), false);
  assert.equal(JSON.stringify(await host.exportData('backup')).includes(first.token), false);
  const stopped = await host.taskBridge(false); assert.equal(stopped.token, null);
  const second = await host.taskBridge(true); assert.notEqual(second.token, first.token);
  assert.equal((await sendTask(second, { ...body, eventId: 'build-2' }, first.token)).status, 401);
  assert.equal((await sendTask(second, { ...body, eventId: 'build-2', command: 'not-allowed' })).status, 400);
  await host.taskBridge(false);
});

test('stopped host cannot mutate private data or reopen its task listener', async t => {
  const { host } = await fixture(t); await host.ready; host.stop();
  await assert.rejects(host.dispatch({ type: 'todo.add', text: 'late write' }));
  await assert.rejects(host.taskBridge(true));
  await assert.rejects(host.assistantCall({ method: 'configure', payload: { enabled: true } }));
  await assert.rejects(host.previewRestore({}));
  await assert.rejects(host.restoreBackup({backup: {}, confirmed: true}));
});

test('backup preview is read-only and confirmed restore writes a reusable old-state backup without credentials', async t => {
  const {host, directory} = await fixture(t);await host.ready;
  await host.dispatch({type: 'todo.add', text: '旧待办'});
  await host.dispatch({type: 'memory.add', text: '旧记忆', source: '旧来源'});
  const secret = 'host-restore-private-api-key';
  await host.assistantCall({method: 'configure', payload: {enabled: true, endpoint: 'https://assistant.example/v1', model: 'mock', apiKey: secret}});
  const imported = await host.exportData('backup');
  imported.companion.todos[0].text = '恢复后的待办';imported.companion.profile.persona = '恢复后的人设';
  const original = await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'), files = await fs.readdir(directory);
  const preview = await host.previewRestore(imported);assert.equal(preview.todos, 1);assert.equal(preview.memories, 1);
  assert.equal((await host.state()).companion.todos[0].text, '旧待办');
  assert.equal(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8'), original);assert.deepEqual(await fs.readdir(directory), files);
  await assert.rejects(host.restoreBackup({backup: imported, confirmed: false}));
  assert.deepEqual(await fs.readdir(directory), files);
  const result = await host.restoreBackup({backup: imported, confirmed: true});
  assert.match(result.backupFile, /^companion-before-restore-[a-zA-Z0-9-]+\.json$/);assert.equal(path.basename(result.backupFile), result.backupFile);
  assert.equal(result.companion.todos[0].text, '恢复后的待办');assert.equal(result.assistant.persona, '恢复后的人设');assert.equal(result.assistant.hasApiKey, true);
  const beforeRestore = JSON.parse(await fs.readFile(path.join(directory, result.backupFile), 'utf8'));
  assert.equal(beforeRestore.schema, 'andromeda.backup/v1');assert.equal(beforeRestore.companion.todos[0].text, '旧待办');
  assert.equal(JSON.stringify(beforeRestore).includes(secret), false);assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await host.previewRestore(beforeRestore)).memories, 1);
  await host.dispatch({type: 'todo.add', text: '新引擎继续工作'});
  assert.equal((await host.state()).companion.todos.length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'companion-v1.json'), 'utf8')).todos[1].text, '新引擎继续工作');
});

test('restoring a running focus pauses it without counting offline time or XP', async t => {
  const {host} = await fixture(t);await host.ready;
  await host.dispatch({type: 'focus.start', durationMinutes: 1});const backup = await host.exportData('backup');
  await host.dispatch({type: 'focus.cancel'});
  const result = await host.restoreBackup({backup, confirmed: true});
  assert.equal(result.summary.focusPaused, true);assert.equal(result.companion.focus.status, 'paused');
  assert.equal(result.companion.focus.remainingMs, backup.companion.focus.remainingMs);assert.equal(result.companion.progression.xp, 0);
});

test('restore failures at either atomic rename preserve the current file and in-memory engine', async t => {
  const {host, directory} = await fixture(t);await host.ready;await host.dispatch({type: 'todo.add', text: '必须保留'});
  const target = path.join(directory, 'companion-v1.json'), original = await fs.readFile(target, 'utf8'), imported = await host.exportData('backup');
  imported.companion.todos[0].text = '不能提交';
  const synchronousFS = require('node:fs'), rename = synchronousFS.renameSync;
  for (const step of ['old-backup', 'new-save']) {
    synchronousFS.renameSync = (from, to) => {
      if ((step === 'old-backup' && path.basename(to).startsWith('companion-before-restore-')) || (step === 'new-save' && to === target)) throw new Error('injected disk failure');
      return rename(from, to);
    };
    try {await assert.rejects(host.restoreBackup({backup: imported, confirmed: true}), /当前记录保持不变/);}
    finally {synchronousFS.renameSync = rename;}
    assert.equal((await host.state()).companion.todos[0].text, '必须保留');assert.equal(await fs.readFile(target, 'utf8'), original);
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  }
});

test('profile edits synchronize canonical persona immediately and assistant lifecycle uses distinct passive event IDs', async t => {
  const requests = [], {host, events} = await fixture(t, {assistantFetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices: [{message: {content: '回答'}, finish_reason: 'stop'}]}), {headers: {'Content-Type': 'application/json'}});
  }});await host.ready;
  await host.assistantCall({method: 'configure', payload: {enabled: true, endpoint: 'http://127.0.0.1:45678/v1', model: 'mock', persona: '过时的表单人设'}});
  await host.dispatch({type: 'profile.update', patch: {persona: '新的温和人设'}});
  assert.equal((await host.state()).assistant.persona, '新的温和人设');
  await host.assistantCall({method: 'chat', payload: {text: '你好'}});
  assert.ok(requests[0].messages.some(message => message.role === 'system' && message.content.includes('新的温和人设')));
  const lifecycle = events.filter(event => event.kind === 'assistant.activity');
  assert.deepEqual(lifecycle.map(event => event.stage), ['working', 'result']);assert.notEqual(lifecycle[0].id, lifecycle[1].id);
  assert.equal(lifecycle[0].taskId, lifecycle[1].taskId);assert.equal(lifecycle[0].requestId, lifecycle[1].requestId);
  assert.ok(lifecycle.every(event => event.priority < 60 && event.resumable === false));
  assert.equal(JSON.stringify(lifecycle).includes('新的温和人设'), false);
});

test('assistant cancellation and failure supersede thinking once without late success', async t => {
  let mode = 'pending';const {host, events} = await fixture(t, {assistantFetch: async () => {
    if (mode === 'pending') return new Promise(() => {});
    throw new Error('private upstream error');
  }});await host.ready;
  await host.assistantCall({method: 'configure', payload: {enabled: true, endpoint: 'http://127.0.0.1:45678/v1', model: 'mock'}});
  const pending = host.assistantCall({method: 'chat', payload: {text: '等待取消'}}), rejected = assert.rejects(pending, {code: 'CANCELLED'});
  for (let i = 0; i < 20 && !events.some(event => event.stage === 'working'); i++) await delay(5);
  host.cancelAssistant();await rejected;
  assert.deepEqual(events.filter(event => event.kind === 'assistant.activity').map(event => event.stage), ['working', 'cancelled']);
  mode = 'failed';await assert.rejects(host.assistantCall({method: 'chat', payload: {text: '失败'}}), {code: 'NETWORK'});
  assert.deepEqual(events.filter(event => event.kind === 'assistant.activity').map(event => event.stage), ['working', 'cancelled', 'working', 'error']);
  assert.equal(JSON.stringify(events).includes('private upstream error'), false);
});

test('model receives closed tool schemas and suggestions require a separate explicit confirmation', async t => {
  const requests = [], {host} = await fixture(t, {assistantFetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({choices: [{message: {content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'addTodo', arguments: JSON.stringify({text: '模型建议的待办'})}}]}, finish_reason: 'tool_calls'}]}), {headers: {'Content-Type': 'application/json'}});
  }});await host.ready;
  await host.assistantCall({method: 'configure', payload: {enabled: true, toolsEnabled: true, endpoint: 'http://127.0.0.1:45678/v1', model: 'mock'}});
  await host.assistantCall({method: 'chat', payload: {text: '建议一个待办'}});
  const schemas = Object.fromEntries(requests[0].tools.map(tool => [tool.function.name, tool.function.parameters]));
  assert.equal(schemas.openWebsite.additionalProperties, false);assert.deepEqual(schemas.openWebsite.properties, {});
  assert.equal(schemas.addTodo.additionalProperties, false);assert.deepEqual(schemas.addTodo.required, ['text']);
  assert.equal(schemas.addTodo.properties.text.minLength, 1);assert.equal(schemas.addTodo.properties.text.maxLength, 500);
  const before = await host.state();assert.equal(before.companion.todos.length, 0);assert.equal(before.assistant.pendingTools.length, 1);
  await host.assistantCall({method: 'confirmTool', payload: {id: before.assistant.pendingTools[0].id, confirmed: true}});
  assert.equal((await host.state()).companion.todos[0].text, '模型建议的待办');
});

test('a delayed persona save returns the latest companion state after a newer command commits', async t => {
  const {host}=await fixture(t);await host.ready;
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const rename=fs.rename;
  fs.rename=async(from,to)=>{if(path.basename(to)==='assistant.json'){entered();await gate;}return rename(from,to);};
  try{
    const saving=host.dispatch({type:'profile.update',patch:{persona:'保存人设时也可以添加待办'}});
    await arrived;
    const added=await host.dispatch({type:'todo.add',text:'必须留在新快照里'});
    release();const result=await saving;
    assert.deepEqual(result.state.todos,added.state.todos);
    assert.deepEqual(result.state.todos,(await host.state()).companion.todos);
  }finally{fs.rename=rename;release();}
});

test('private bridge reads never start a listener and restore the current session after the panel closes', async t => {
  const {host,publications}=await fixture(t);
  const closed={running:false,enabled:false,host:'127.0.0.1',port:null,url:null,token:null};
  assert.deepEqual(await host.taskBridgeState(),closed);
  assert.deepEqual((await host.state()).bridge,closed);
  const started=await host.taskBridge(true);
  assert.equal(publications.at(-1).bridge.token,started.token);
  host.cancelAssistant(); // Closing the private window only cancels assistant work.
  assert.deepEqual(await host.taskBridgeState(),started);
  assert.deepEqual((await host.state()).bridge,started);
  assert.equal(JSON.stringify(host.publicState()).includes(started.token),false);
  assert.equal(JSON.stringify(await host.exportData('backup')).includes(started.token),false);
  const exposed=await host.taskBridgeState();exposed.token='changed';
  assert.equal((await host.taskBridgeState()).token,started.token);
  await host.taskBridge(false);assert.deepEqual(await host.taskBridgeState(),closed);
  const restarted=await host.taskBridge(true);assert.notEqual(restarted.token,started.token);
  await host.stop();assert.deepEqual(await host.taskBridgeState(),closed);
});
