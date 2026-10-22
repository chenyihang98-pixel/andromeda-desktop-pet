'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAssistantService, endpointValue, validatePatch, MAX_AUDIO_BYTES } = require('../src/services/assistant.cjs');

const configured = { enabled: true, endpoint: 'https://assistant.example/v1', model: 'chosen-chat-model', apiKey: 'test-private-key-928473' };
const completion = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'content-type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function stream(chunks) {
  const bytes = chunks.map(chunk => typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of bytes) controller.enqueue(chunk);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andromeda-assistant-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('andromeda-assistant-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const events = [];
  const service = createAssistantService({ directory, onEvent: event => events.push(event), ...options });
  return { directory, events, service };
}

test('disabled defaults never call a network or capture dependency', async t => {
  let calls = 0;
  const { service } = await fixture(t, { fetchImpl: () => { calls += 1; }, capture: () => { calls += 1; } });
  assert.equal(service.snapshot().enabled, false);
  assert.equal(service.snapshot().captureEnabled, false);
  await assert.rejects(service.chat({ text: 'hello' }), { code: 'DISABLED' });
  await assert.rejects(service.captureOnce({ confirmed: true }), { code: 'PERMISSION' });
  assert.equal(calls, 0);
  assert.equal(service.snapshot().usage.requests, 0);
});

test('endpoint validation allows HTTPS and explicit loopback HTTP only', () => {
  for (const input of ['https://service.example/v1/', 'http://localhost:1234/v1', 'http://127.0.0.1:8000', 'http://[::1]:8000/v1']) {
    assert.equal(endpointValue(input), input.replace(/\/+$/u, ''));
  }
  for (const input of ['http://service.example/v1', 'http://192.168.1.2/v1', 'http://localhost.evil.test/v1',
    'http://127.1/v1', 'https://user:pass@service.example', 'https://service.example?key=secret',
    'https://service.example/#secret', 'file:///tmp/api', 'https://service.example/../api',
    'https://service.example/%2e%2e/api', 'https://service.example\\evil.test', ' https://service.example',
    'https://service.example/a\nb', 'https://service.example/' + 'a'.repeat(520)]) {
    assert.throws(() => endpointValue(input), { code: 'INVALID_CONFIG' }, input);
  }
});

test('configuration is atomic and rejects unknown fields and malformed credentials', async t => {
  const { service } = await fixture(t);
  for (const patch of [{ enabled: 'true' }, { timeoutMs: 0 }, { model: 'bad\nmodel' },
    { apiKey: 'header\r\nInjected: true' }, { enabled: true, unknown: 1 }, JSON.parse('{"__proto__":{}}'),
    { dailyRequestLimit: 1001 }, { historyMessages: Infinity }, { persona: 'x'.repeat(4001) }]) {
    await assert.rejects(service.configure(patch), { code: 'INVALID_CONFIG' });
    assert.equal(service.snapshot().enabled, false);
  }
  assert.throws(() => validatePatch(Object.create({ enabled: true })), { code: 'INVALID_CONFIG' });
});

test('missing configuration is actionable; local providers may omit a key', async t => {
  let headers;
  const { service } = await fixture(t, { fetchImpl: async (url, options) => { headers = options.headers; return completion('本地回复'); } });
  await service.configure({ enabled: true });
  await assert.rejects(service.chat({ text: 'test' }), { code: 'NOT_CONFIGURED' });
  await service.configure({ endpoint: 'http://localhost:1234/v1', model: 'local-model' });
  assert.equal((await service.chat({ text: 'test' })).text, '本地回复');
  assert.equal(headers.Authorization, undefined);
});

test('session-only key is never written, exported or exposed when safe encryption is unavailable', async t => {
  const { service, directory } = await fixture(t, { safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => { throw new Error('must not use insecure fallback'); },
  } });
  await service.configure(configured);
  assert.equal(service.snapshot().keyStorage, 'session');
  assert.equal(service.snapshot().hasApiKey, true);
  for (const value of [service.snapshot(), service.exportData(), await fs.readFile(path.join(directory, 'assistant.json'), 'utf8')]) {
    assert.ok(!JSON.stringify(value).includes(configured.apiKey));
  }
  const restored = createAssistantService({ directory });
  await restored.load();
  assert.equal(restored.snapshot().hasApiKey, false);
});

test('safeStorage encrypts and restores keys; endpoint change forgets credentials and prior history', async t => {
  let encryptions = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => { encryptions += 1; return Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x57)); },
    decryptString: bytes => Buffer.from([...bytes].map(byte => byte ^ 0x57)).toString(),
  };
  const { service, directory } = await fixture(t, { safeStorage, fetchImpl: async () => completion('ok') });
  await service.configure(configured);
  assert.equal(service.snapshot().keyStorage, 'encrypted');
  assert.ok(encryptions > 0);
  const record = JSON.parse(await fs.readFile(path.join(directory, 'assistant.json'), 'utf8'));
  assert.equal(typeof record.encryptedKey, 'string');
  assert.equal(JSON.stringify(record).includes(configured.apiKey), false);
  const restored = createAssistantService({ directory, safeStorage });
  await restored.load();
  assert.equal(restored.snapshot().hasApiKey, true);
  await service.chat({ text: 'hello' });
  await service.configure({ endpoint: 'https://another.example/v1' });
  assert.equal(service.snapshot().hasApiKey, false);
  assert.equal(service.snapshot().history.length, 0);
  await assert.rejects(service.chat({ text: 'hello' }), { code: 'NOT_CONFIGURED' });
  await service.configure({ endpoint: 'https://third.example/v1', apiKey: 'another-test-key' });
  assert.equal(service.snapshot().hasApiKey, true);
});

test('malformed storage does not block offline companion initialization', async t => {
  const { service, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'assistant.json'), '{bad JSON');
  const snapshot = await service.load();
  assert.equal(snapshot.enabled, false);
  assert.equal(typeof snapshot.persistenceError, 'string');
});

test('chat sends only supplied context and history, with bounded tokens and no redirects', async t => {
  const calls = [];
  const { service, directory } = await fixture(t, { fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return completion('完成回复'); } });
  await service.configure({ ...configured, maxTokens: 128, tokenParameter: 'max_completion_tokens', historyMessages: 2 });
  await service.chat({ text: '第一句', context: '本次资料', memory: '选中记忆' });
  await service.chat({ text: '第二句' });
  assert.equal(calls[0].url, 'https://assistant.example/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].body.max_completion_tokens, 128);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${configured.apiKey}`);
  assert.ok(JSON.stringify(calls[0].body).includes('选中记忆'));
  assert.ok(!JSON.stringify(calls[1].body).includes('选中记忆'));
  assert.ok(!JSON.stringify(service.snapshot().history).includes('本次资料'));
  assert.equal(service.snapshot().history.length, 2);
  const persisted = await fs.readFile(path.join(directory, 'assistant.json'), 'utf8');
  assert.ok(!persisted.includes('第一句'));
});

test('saving unchanged connection fields preserves history; changing a model clears it', async t => {
  const { service } = await fixture(t, { fetchImpl: async () => completion('回复') });
  await service.configure(configured);
  await service.chat({ text: '保留这一句' });
  const before = service.snapshot().history;
  await service.configure({ endpoint: configured.endpoint, model: configured.model,
    persona: service.snapshot().persona, dailyRequestLimit: 60 });
  assert.deepEqual(service.snapshot().history, before);
  await service.configure({ model: 'different-model' });
  assert.deepEqual(service.snapshot().history, []);
});

test('SSE handles every UTF-8 byte boundary, CRLF and keepalive records', async t => {
  const payload = ': heartbeat\r\n\r\n' + delta('你好').replaceAll('\n', '\r\n') + delta('，世界') + 'data: [DONE]\r\n\r\n';
  const chunks = [...Buffer.from(payload)].map(byte => Uint8Array.of(byte));
  const { service, events } = await fixture(t, { fetchImpl: async () => stream(chunks) });
  await service.configure(configured);
  const result = await service.chat({ text: 'hello' });
  assert.equal(result.text, '你好，世界');
  assert.equal(events.filter(event => event.type === 'assistant:delta').map(event => event.text).join(''), result.text);
  assert.equal(service.snapshot().history.at(-1).content, result.text);
});

test('streamed key echoes split over chunks are redacted before UI events and history', async t => {
  const key = configured.apiKey;
  const { service, events } = await fixture(t, { fetchImpl: async () => stream([delta('hello ' + key.slice(0, 6)), delta(key.slice(6, 12)), delta(key.slice(12) + ' bye'), 'data: [DONE]\n\n']) });
  await service.configure(configured);
  const result = await service.chat({ text: 'hi' });
  assert.equal(result.text, 'hello [redacted] bye');
  for (const value of [result, events, service.snapshot(), service.exportData()]) assert.ok(!JSON.stringify(value).includes(key));
});

test('HTTP errors never forward raw provider bodies or credentials', async t => {
  const { service, events } = await fixture(t, { fetchImpl: async () => new Response(`secret was ${configured.apiKey}`, { status: 401 }) });
  await service.configure(configured);
  await assert.rejects(service.chat({ text: 'hi' }), error => error.code === 'AUTH' && !error.message.includes(configured.apiKey));
  assert.equal(JSON.stringify(events).includes(configured.apiKey), false);
  assert.equal(service.snapshot().history.length, 0);
});

test('invalid/incomplete SSE fails without committing partial history', async t => {
  for (const payload of [delta('partial'), 'data: {bad\n\n', 'data: null\n\n', 'data: {"error":{"message":"secret"}}\n\n']) {
    const { service } = await fixture(t, { fetchImpl: async () => stream([payload]) });
    await service.configure(configured);
    await assert.rejects(service.chat({ text: 'hi' }), error => ['RESPONSE', 'REMOTE'].includes(error.code));
    assert.equal(service.snapshot().history.length, 0);
  }
});

test('per-request input and output limits stop work and preserve history', async t => {
  let calls = 0;
  const { service } = await fixture(t, { fetchImpl: async () => { calls += 1; return stream([delta('12345'), 'data: [DONE]\n\n']); } });
  await service.configure({ ...configured, maxInputChars: 3, maxOutputChars: 4 });
  await assert.rejects(service.chat({ text: '1234' }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  await assert.rejects(service.chat({ text: '123' }), { code: 'TOO_LARGE' });
  assert.equal(service.snapshot().history.length, 0);
});

test('cancel settles even when fetch ignores abort; late responses never overwrite a new request', async t => {
  let lateResolve, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let call = 0;
  const { service, events } = await fixture(t, { fetchImpl: async () => {
    call += 1;
    if (call === 1) { startedResolve(); return new Promise(resolve => { lateResolve = resolve; }); }
    return completion('新任务');
  } });
  await service.configure(configured);
  const first = service.chat({ text: '旧任务' });
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  await started;
  const oldId = service.snapshot().status.requestId;
  assert.equal(service.cancel('wrong-id'), false);
  assert.equal(service.cancel(oldId), true);
  await rejected;
  assert.equal((await service.chat({ text: '新任务' })).text, '新任务');
  lateResolve(completion('迟到结果'));
  await tick(); await tick();
  assert.ok(!JSON.stringify(service.snapshot().history).includes('迟到结果'));
  assert.ok(!events.some(event => event.type === 'assistant:result' && event.requestId === oldId));
  assert.equal(service.snapshot().status.kind, 'idle');
});

test('timeout settles when the provider never resolves and allows another request', async t => {
  let calls = 0;
  const { service } = await fixture(t, { fetchImpl: async () => { calls += 1; return calls === 1 ? new Promise(() => {}) : completion('retry'); } });
  await service.configure({ ...configured, timeoutMs: 100 });
  await assert.rejects(service.chat({ text: 'hi' }), { code: 'TIMEOUT' });
  assert.equal(service.snapshot().status.kind, 'idle');
  assert.equal((await service.chat({ text: 'again' })).text, 'retry');
});

test('cancel during a streaming delta prevents terminal success and history resurrection', async t => {
  const { directory } = await fixture(t);
  let service;
  service = createAssistantService({ directory, fetchImpl: async () => stream([delta('a long enough first content chunk for flushing safely'), delta('later'), 'data: [DONE]\n\n']),
    onEvent: event => { if (event.type === 'assistant:delta') service.clearHistory(); } });
  await service.configure(configured);
  await assert.rejects(service.chat({ text: 'hi' }), { code: 'CANCELLED' });
  assert.equal(service.snapshot().history.length, 0);
});

test('daily request budget persists across restarts and resets only on the next UTC date', async t => {
  let instant = Date.UTC(2026, 9, 22, 23, 59);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return completion('ok'); };
  const { directory, service } = await fixture(t, { now: () => instant, fetchImpl });
  await service.configure({ enabled: true, endpoint: 'http://localhost:1234/v1', model: 'local', dailyRequestLimit: 1 });
  await service.chat({ text: 'one' });
  const restored = createAssistantService({ directory, now: () => instant, fetchImpl });
  await restored.load();
  await assert.rejects(restored.chat({ text: 'two' }), { code: 'LIMIT' });
  assert.equal(calls, 1);
  instant += 120000;
  await restored.chat({ text: 'new day' });
  assert.equal(calls, 2);
  assert.equal(restored.snapshot().usage.requests, 1);
});

test('ASR uploads bounded explicit audio, and TTS returns bounded bytes without playing audio', async t => {
  const calls = [];
  const { service } = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/transcriptions')
      ? new Response('{"text":"转写内容"}', { headers: { 'content-type': 'application/json' } })
      : new Response(Buffer.from([1, 2, 3, 4]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  await service.configure({ ...configured, asrModel: 'chosen-asr', ttsModel: 'chosen-tts' });
  assert.equal((await service.transcribe({ audio: Buffer.from([1, 2, 3]), mimeType: 'audio/webm' })).text, '转写内容');
  const speech = await service.synthesize({ text: '你好' });
  assert.equal(speech.mimeType, 'audio/mpeg');
  assert.deepEqual(Buffer.from(speech.audioBase64, 'base64'), Buffer.from([1, 2, 3, 4]));
  assert.equal(calls[0].options.body.get('model'), 'chosen-asr');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.equal(JSON.parse(calls[1].options.body).response_format, 'mp3');
  assert.equal(service.snapshot().history.length, 0);
  assert.equal(service.snapshot().usage.requests, 2);
});

test('oversized or unknown audio is rejected before fetching and oversized TTS is stopped', async t => {
  let calls = 0;
  const { service } = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    return new Response('x', { headers: { 'content-type': 'audio/mpeg', 'content-length': String(MAX_AUDIO_BYTES + 1) } });
  } });
  await service.configure({ ...configured, asrModel: 'chosen-asr', ttsModel: 'chosen-tts' });
  await assert.rejects(service.transcribe({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mimeType: 'audio/webm' }), { code: 'INVALID_INPUT' });
  await assert.rejects(service.transcribe({ audio: Buffer.from('x'), mimeType: 'text/html' }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  await assert.rejects(service.synthesize({ text: 'hello' }), { code: 'TOO_LARGE' });
  assert.equal(calls, 1);
});

test('capture requires both opt-in and per-call confirmation, is never auto-sent, and image URLs are refused', async t => {
  const image = 'data:image/png;base64,aGVsbG8=';
  let captures = 0;
  const requests = [];
  const { service } = await fixture(t, { capture: async () => { captures += 1; return image; }, fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return completion('ok'); } });
  await service.configure(configured);
  await assert.rejects(service.captureOnce({ confirmed: true }), { code: 'PERMISSION' });
  await service.configure({ captureEnabled: true });
  await assert.rejects(service.captureOnce({ confirmed: false }), { code: 'PERMISSION' });
  assert.equal((await service.captureOnce({ confirmed: true })).image, image);
  assert.equal(captures, 1);
  assert.equal(requests.length, 0);
  await service.chat({ text: 'without image' });
  assert.ok(!JSON.stringify(requests[0]).includes('data:image'));
  await service.chat({ text: 'describe selected capture', image });
  assert.ok(JSON.stringify(requests[1]).includes(image));
  assert.ok(!JSON.stringify(service.snapshot()).includes(image));
  await assert.rejects(service.chat({ text: 'unsafe', image: 'https://other.example/image.png' }), { code: 'INVALID_INPUT' });
});

test('tools require an allowlisted validator, a reviewable card and a single explicit confirmation', async t => {
  let executions = 0;
  const { service } = await fixture(t, { toolHandlers: {
    addTodo: { label: '添加待办', validate: args => Object.keys(args).length === 1 && typeof args.title === 'string' && args.title.length <= 100,
      run: async args => { executions += 1; return { created: args.title }; } },
    openSite: async () => { executions += 1; return 'opened-fixed-site'; },
  } });
  assert.throws(() => service.proposeTool({ name: 'openSite' }), { code: 'PERMISSION' });
  await service.configure({ toolsEnabled: true });
  assert.throws(() => service.proposeTool({ name: 'shell', args: { command: 'anything' } }), { code: 'TOOL' });
  assert.throws(() => service.proposeTool({ name: 'openSite', args: { url: 'https://arbitrary.example' } }), { code: 'TOOL' });
  assert.throws(() => service.proposeTool({ name: 'addTodo', args: JSON.parse('{"__proto__":{"polluted":true}}') }), { code: 'TOOL' });
  const card = service.proposeTool({ name: 'addTodo', args: { title: '喝水' } });
  assert.equal(executions, 0);
  assert.equal(service.snapshot().pendingTools[0].label, '添加待办');
  card.args.title = 'changed';
  const result = await service.confirmTool({ id: card.id, confirmed: true });
  assert.equal(result.result.created, '喝水');
  assert.equal(executions, 1);
  await assert.rejects(service.confirmTool({ id: card.id, confirmed: true }), { code: 'TOOL' });
  const declined = service.proposeTool({ name: 'openSite' });
  await service.confirmTool({ id: declined.id, confirmed: false });
  assert.equal(executions, 1);
});

test('expired tool cards cannot execute and model tool_calls never run injected handlers', async t => {
  let instant = Date.UTC(2026, 9, 22);
  let executions = 0;
  const { service } = await fixture(t, { now: () => instant, toolHandlers: { openSite: () => { executions += 1; } },
    fetchImpl: async () => stream(['data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"openSite","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n']) });
  await service.configure({ ...configured, toolsEnabled: true });
  const card = service.proposeTool({ name: 'openSite' });
  instant += 300001;
  await assert.rejects(service.confirmTool({ id: card.id, confirmed: true }), { code: 'TOOL' });
  await assert.rejects(service.chat({ text: 'open site' }), { code: 'RESPONSE' });
  assert.equal(executions, 0);
});

test('failed tool handlers produce a safe error and are never retried', async t => {
  let executions = 0;
  const { service, events } = await fixture(t, { toolHandlers: { fail: () => { executions += 1; throw new Error(configured.apiKey); } } });
  await service.configure({ ...configured, toolsEnabled: true });
  const card = service.proposeTool({ name: 'fail' });
  await assert.rejects(service.confirmTool({ id: card.id, confirmed: true }), { code: 'TOOL_FAILED' });
  await assert.rejects(service.confirmTool({ id: card.id, confirmed: true }), { code: 'TOOL' });
  assert.equal(executions, 1);
  assert.equal(JSON.stringify(events).includes(configured.apiKey), false);
});

const emptyParameters = () => ({type: 'object', properties: {}, additionalProperties: false});
const todoParameters = () => ({type: 'object', properties: {text: {type: 'string', minLength: 1, maxLength: 100}},
  required: ['text'], additionalProperties: false});
const toolResult = (toolCalls, {text = null, finish = 'tool_calls'} = {}) => new Response(JSON.stringify({choices: [
  {message: {content: text, tool_calls: toolCalls}, finish_reason: finish},
]}), {headers: {'content-type': 'application/json'}});
const modelCall = (name, args = '{}') => ({id: 'provider-call-id', type: 'function', function: {name, arguments: args}});
const toolDelta = (toolCalls, finish = null) => `data: ${JSON.stringify({choices: [{delta: {tool_calls: toolCalls}, finish_reason: finish}]})}\n\n`;

test('only enabled schema-bearing tools enter the request, and schemas are validated and copied', async t => {
  const calls = [], parameters = emptyParameters();
  const {service} = await fixture(t, {toolHandlers: {
    openSite: {parameters, validate: args => Object.keys(args).length === 0, run() {}},
    manualOnly: {validate: () => true, run() {}}, functionOnly() {},
  }, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return completion('plain answer'); }});
  parameters.properties.unexpected = {type: 'string'};
  await service.configure(configured);
  await service.chat({text: 'disabled tools'});
  assert.equal(calls[0].tools, undefined);
  await service.configure({toolsEnabled: true});
  await service.chat({text: 'enabled tools'});
  assert.deepEqual(calls[1].tools.map(tool => tool.function.name), ['openSite']);
  assert.deepEqual(calls[1].tools[0].function.parameters.properties, {});
  assert.equal(calls[1].tools[0].function.parameters.additionalProperties, false);
  for (const schema of [{type: 'object', properties: {}, additionalProperties: true},
    {type: 'object', properties: {}, $ref: 'https://attacker.example/schema'},
    {type: 'object', properties: {text: {type: 'string', pattern: '(a+)+$'}}},
    {type: 'string'}, {type: 'object', properties: {}, required: ['unknown']},
    {type: 'object', properties: {text: {type: 'string', maxLength: 5000}}}]) {
    assert.throws(() => createAssistantService({directory: path.resolve(os.tmpdir()), toolHandlers: {
      unsafe: {parameters: schema, validate: () => true, run() {}},
    }}), {code: 'TOOL'});
  }
});

test('fragmented and interleaved SSE function calls become review cards and execute only on one confirmation', async t => {
  const executed = [];
  const {service, events} = await fixture(t, {toolHandlers: {
    addTodo: {label: '添加待办', parameters: todoParameters(), validate: args => typeof args.text === 'string' && args.text.trim().length > 0,
      run: args => { executed.push(args.text); return true; }},
    openSite: {label: '打开固定网站', parameters: emptyParameters(), validate: args => Object.keys(args).length === 0,
      run: () => { executed.push('fixed-site'); return true; }},
  }, fetchImpl: async () => stream([
    toolDelta([{index: 0, id: 'call-0', type: 'function', function: {name: 'add', arguments: '{"te'}}]),
    toolDelta([{index: 1, id: 'call-1', type: 'function', function: {name: 'open', arguments: '{'}}]),
    toolDelta([{index: 0, function: {name: 'Todo', arguments: 'xt":"喝'}}]),
    toolDelta([{index: 1, function: {name: 'Site', arguments: '}'}}]),
    toolDelta([{index: 0, function: {arguments: '水"}'}}], 'tool_calls'), 'data: [DONE]\n\n',
  ])});
  await service.configure({...configured, toolsEnabled: true});
  const response = await service.chat({text: '记得喝水，再打开网站'});
  assert.match(response.text, /尚未执行.*请确认操作卡/);
  const cards = service.snapshot().pendingTools;
  assert.deepEqual(cards.map(card => card.name), ['addTodo', 'openSite']);
  assert.deepEqual(cards[0].args, {text: '喝水'});
  assert.deepEqual(executed, []);
  assert.equal(events.filter(event => event.type === 'assistant:tool' && event.status === 'pending').length, 2);
  await service.confirmTool({id: cards[0].id, confirmed: true});
  await assert.rejects(service.confirmTool({id: cards[0].id, confirmed: true}), {code: 'TOOL'});
  await service.confirmTool({id: cards[1].id, confirmed: false});
  assert.deepEqual(executed, ['喝水']);
  assert.deepEqual(service.snapshot().pendingTools, []);
});

test('JSON-compatible tool-only and text-with-tool replies both clearly request confirmation', async t => {
  const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true,
    run: () => assert.fail('Must not execute a model call')}},
  fetchImpl: async () => toolResult([modelCall('openSite')], {text: null})});
  await service.configure({...configured, toolsEnabled: true});
  assert.match((await service.chat({text: 'open'})).text, /请确认操作卡/);
  assert.equal(service.snapshot().pendingTools.length, 1);
  assert.equal(service.snapshot().history.at(-1).content, '操作尚未执行，请确认操作卡。');
  const other = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
    fetchImpl: async () => toolResult([modelCall('openSite')], {text: '我可以帮你打开。'})});
  await other.service.configure({...configured, toolsEnabled: true});
  const response = await other.service.chat({text: 'open'});
  assert.match(response.text, /^我可以帮你打开。\n\n操作尚未执行/);
});

test('unknown/unoffered tools and invalid arguments fail the whole batch without leaving cards or history', async t => {
  for (const invalid of [modelCall('shell', '{"command":"anything"}'), modelCall('manualOnly'),
    modelCall('openSite', '{"url":"https://attacker.example"}'), modelCall('openSite', '[]'),
    modelCall('openSite', 'null'), modelCall('openSite', '{"__proto__":{"polluted":true}}'),
    modelCall('openSite', '{"constructor":{"prototype":{"polluted":true}}}'), modelCall('openSite', '{'),
    modelCall('addTodo', '{"text":123}'), modelCall('addTodo', '{"text":""}'), modelCall('addTodo', '{"text":"   "}'),
    modelCall('addTodo', JSON.stringify({text: 'x'.repeat(101)}))]) {
    const {service, events} = await fixture(t, {toolHandlers: {
      openSite: {parameters: emptyParameters(), validate: () => true, run: () => assert.fail('No execution')},
      addTodo: {parameters: todoParameters(), validate: args => args.text.trim().length > 0, run: () => assert.fail('No execution')},
      manualOnly: () => assert.fail('Not exposed to the model'),
    }, fetchImpl: async () => toolResult([modelCall('openSite'), invalid])});
    await service.configure({...configured, toolsEnabled: true});
    await assert.rejects(service.chat({text: 'bad batch'}), {code: 'TOOL'});
    assert.deepEqual(service.snapshot().pendingTools, []);
    assert.deepEqual(service.snapshot().history, []);
    assert.equal(events.some(event => event.type === 'assistant:tool'), false);
  }
  assert.equal({}.polluted, undefined);
});

test('tool-call count, index, name and UTF-8 argument budgets are enforced before proposals', async t => {
  const bodies = [
    [toolDelta(Array.from({length: 5}, (_, index) => ({index, ...modelCall('openSite')}))), 'data: [DONE]\n\n'],
    [toolDelta([{index: 4, ...modelCall('openSite')}]), 'data: [DONE]\n\n'],
    [toolDelta([{index: '0', ...modelCall('openSite')}]), 'data: [DONE]\n\n'],
    [toolDelta([{index: 0, ...modelCall('x'.repeat(65))}]), 'data: [DONE]\n\n'],
    [toolDelta([{index: 0, ...modelCall('openSite', '界'.repeat(1366))}]), 'data: [DONE]\n\n'],
    [toolDelta([{index: 0, ...modelCall('openSite'), type: 'custom'}]), 'data: [DONE]\n\n'],
  ];
  for (const chunks of bodies) {
    const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
      fetchImpl: async () => stream(chunks)});
    await service.configure({...configured, toolsEnabled: true});
    await assert.rejects(service.chat({text: 'bounded calls'}), error => ['RESPONSE', 'TOO_LARGE'].includes(error.code));
    assert.deepEqual(service.snapshot().pendingTools, []);
  }
});

test('truncated, malformed and incomplete tool responses leave existing cards unchanged', async t => {
  for (const chunks of [
    [toolDelta([{index: 0, ...modelCall('openSite')}])],
    [toolDelta([{index: 0, ...modelCall('openSite')}], 'length'), 'data: [DONE]\n\n'],
    [toolDelta([{index: 0, ...modelCall('openSite')}]), 'data: {broken\n\n'],
  ]) {
    const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
      fetchImpl: async () => stream(chunks)});
    await service.configure({...configured, toolsEnabled: true});
    const existing = service.proposeTool({name: 'openSite'});
    await assert.rejects(service.chat({text: 'incomplete'}), {code: 'RESPONSE'});
    assert.deepEqual(service.snapshot().pendingTools.map(card => card.id), [existing.id]);
  }
});

test('cancelled tool SSE and late completion cannot create cards or replace a newer answer', async t => {
  let controller, callCount = 0, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
    fetchImpl: async () => ++callCount === 1 ? new Response(new ReadableStream({start(value) {
      controller = value; value.enqueue(Buffer.from(toolDelta([{index: 0, ...modelCall('openSite')}]))); startedResolve();
    }}), {headers: {'content-type': 'text/event-stream'}}) : completion('新的回答')});
  await service.configure({...configured, toolsEnabled: true});
  const pending = service.chat({text: 'old request'});
  const rejected = assert.rejects(pending, {code: 'CANCELLED'});
  await started;
  assert.equal(service.cancel(), true); await rejected;
  await service.chat({text: 'new request'});
  controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close(); await tick();
  assert.deepEqual(service.snapshot().pendingTools, []);
  assert.equal(service.snapshot().history.at(-1).content, '新的回答');
});

test('cancellation from a pending-card callback rolls back the whole generated batch', async t => {
  let service;
  const fixtureValue = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
    onEvent: event => { if (event.type === 'assistant:tool') service.cancel(); },
    fetchImpl: async () => toolResult([modelCall('openSite'), modelCall('openSite')])});
  service = fixtureValue.service;
  await service.configure({...configured, toolsEnabled: true});
  await assert.rejects(service.chat({text: 'cancel at commit'}), {code: 'CANCELLED'});
  assert.deepEqual(service.snapshot().pendingTools, []); assert.deepEqual(service.snapshot().history, []);
});

test('a valid multi-card reply cannot partially fill the ten-card pending limit', async t => {
  const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
    fetchImpl: async () => toolResult([modelCall('openSite'), modelCall('openSite')])});
  await service.configure({...configured, toolsEnabled: true});
  const existing = Array.from({length: 9}, () => service.proposeTool({name: 'openSite'}).id);
  await assert.rejects(service.chat({text: 'two more'}), {code: 'TOOL'});
  assert.deepEqual(service.snapshot().pendingTools.map(card => card.id), existing);
  assert.deepEqual(service.snapshot().history, []);
});

test('a timeout after receiving valid tool arguments still leaves no pending card', async t => {
  let controller;
  const {service} = await fixture(t, {toolHandlers: {openSite: {parameters: emptyParameters(), validate: () => true, run() {}}},
    fetchImpl: async () => new Response(new ReadableStream({start(value) {
      controller = value; value.enqueue(Buffer.from(toolDelta([{index: 0, ...modelCall('openSite')}])));
    }}), {headers: {'content-type': 'text/event-stream'}})});
  await service.configure({...configured, toolsEnabled: true, timeoutMs: 100});
  await assert.rejects(service.chat({text: 'slow tool stream'}), {code: 'TIMEOUT'});
  assert.deepEqual(service.snapshot().pendingTools, []);
  controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close(); await tick();
  assert.deepEqual(service.snapshot().pendingTools, []);
  assert.deepEqual(service.snapshot().history, []);
});

test('known credential echoes cannot be hidden in a review card and later persisted by a handler', async t => {
  const {service} = await fixture(t, {toolHandlers: {addTodo: {parameters: todoParameters(), validate: () => true,
    run: () => assert.fail('Credential must not reach a tool handler')}},
    fetchImpl: async () => toolResult([modelCall('addTodo', JSON.stringify({text: configured.apiKey}))])});
  await service.configure({...configured, toolsEnabled: true});
  await assert.rejects(service.chat({text: 'store a todo'}), {code: 'TOOL'});
  assert.deepEqual(service.snapshot().pendingTools, []);
});
