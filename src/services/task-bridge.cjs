'use strict';

const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';
const PATH = '/events';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_REQUESTS_PER_MINUTE = 60;
const STATES = Object.freeze(['working', 'waiting', 'completed', 'failed', 'cancelled']);

function text(value, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid event');
  return value.trim();
}

function identifier(value) {
  const result = text(value, 120);
  if (!/^[a-zA-Z0-9_.:@-]+$/.test(result)) throw new TypeError('Invalid event');
  return result;
}

/** Accepts status data only. No command, file path, arbitrary URL or tool execution. */
function validateTaskEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid event');
  const allowed = ['eventId', 'taskId', 'status', 'title', 'text'];
  if (Reflect.ownKeys(input).some(key => !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))
    || ['eventId', 'taskId', 'status'].some(key => !Object.hasOwn(input, key))
    || !STATES.includes(input.status)) throw new TypeError('Invalid event');
  return Object.freeze({
    type: 'task.event', eventId: identifier(input.eventId), taskId: identifier(input.taskId), status: input.status,
    ...(Object.hasOwn(input, 'title') ? { title: text(input.title, 200) } : {}),
    ...(Object.hasOwn(input, 'text') ? { text: text(input.text, 500, true) } : {}),
  });
}

const hash = value => createHash('sha256').update(value).digest();

function createTaskBridge({ onEvent, now = () => Date.now() } = {}) {
  if (typeof onEvent !== 'function' || typeof now !== 'function') throw new TypeError('A task event handler is required');
  let current = null;
  let lifecycle = Promise.resolve();

  // Private-owner-only: callers must not broadcast this snapshot to the pet or a website.
  function snapshot() {
    return { running: Boolean(current?.running), host: HOST, port: current?.running ? current.port : null,
      url: current?.running ? `http://${HOST}:${current.port}${PATH}` : null,
      token: current?.running ? current.token : null };
  }

  function enqueue(operation) {
    const result = lifecycle.then(operation, operation);
    lifecycle = result.catch(() => {});
    return result;
  }

  function reply(response, status, code) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(status === 202 ? { accepted: true } : { error: code });
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
      ...(status === 405 ? { Allow: 'POST' } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}) });
    response.end(body);
  }

  async function handle(session, request, response) {
    const fail = (status, code) => reply(response, status, code);
    if (current !== session || !session.running) return fail(503, 'STOPPED');
    // Count every attempt, including rejected authentication, on the single loopback listener.
    const time = now();
    if (time < session.windowStart || time - session.windowStart >= 60_000) {
      session.windowStart = time; session.requests = 0;
    }
    if (++session.requests > MAX_REQUESTS_PER_MINUTE) return fail(429, 'RATE_LIMIT');
    if (request.socket.remoteAddress !== HOST) return fail(403, 'LOCAL_ONLY');
    if (Object.hasOwn(request.headers, 'origin') || Object.keys(request.headers).some(key => key.startsWith('sec-fetch-')))
      return fail(403, 'BROWSER_FORBIDDEN');
    const headerCount = name => request.rawHeaders.reduce((count, value, index) =>
      count + (index % 2 === 0 && value.toLowerCase() === name ? 1 : 0), 0);
    // A fixed Host check also prevents a browser from reaching this service through DNS rebinding.
    if (headerCount('host') !== 1 || request.headers.host !== `${HOST}:${session.port}`) return fail(403, 'HOST');
    if (request.url !== PATH) return fail(404, 'NOT_FOUND');
    if (request.method !== 'POST') return fail(405, 'METHOD');
    const authorization = request.headers.authorization;
    const candidate = headerCount('authorization') === 1 && typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
      ? authorization.slice(7) : '';
    const authenticated = timingSafeEqual(hash(candidate), session.tokenHash);
    if (!authenticated) return fail(401, 'AUTH');
    if (headerCount('content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')
      || Object.hasOwn(request.headers, 'content-encoding')) return fail(415, 'CONTENT_TYPE');
    if (request.headers['content-length'] !== undefined
      && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > MAX_BODY_BYTES))
      return fail(413, 'TOO_LARGE');
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { fail(413, 'TOO_LARGE'); return; }
        chunks.push(chunk);
      }
    } catch { return fail(400, 'BODY'); }
    if (current !== session || !session.running) return fail(503, 'STOPPED');
    let event;
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      event = validateTaskEvent(JSON.parse(source));
    } catch { return fail(400, 'EVENT'); }
    try {
      // The host owns dispatch and deduplication. Only the validated event is passed through.
      await onEvent(event);
      if (current !== session || !session.running) return fail(503, 'STOPPED');
      reply(response, 202);
    } catch { fail(500, 'DISPATCH'); }
  }

  async function close(session) {
    if (!session) return;
    session.running = false;
    session.token = '';
    session.tokenHash.fill(0);
    await new Promise(resolve => {
      session.server.close(() => resolve());
      // Explicit stop closes pending uploads/keep-alive connections; no event arrives after stop from them.
      session.server.closeAllConnections();
    });
  }

  function start() {
    return enqueue(async () => {
      if (current?.running) return snapshot();
      const token = randomBytes(32).toString('base64url');
      const session = { token, tokenHash: hash(token), port: null, running: false, requests: 0, windowStart: now() };
      const server = http.createServer({ maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 5000,
        keepAliveTimeout: 1000 }, (request, response) => { handle(session, request, response).catch(() => reply(response, 500, 'REQUEST')); });
      session.server = server;
      server.maxConnections = 8;
      server.setTimeout(5000, socket => socket.destroy());
      server.on('clientError', (_error, socket) => socket.destroy());
      // Do not allow HTTP Upgrade or Expect: 100-continue to bypass the normal request checks.
      server.on('upgrade', (_request, socket) => socket.destroy());
      server.on('checkContinue', (request, response) => reply(response, 417, 'EXPECTATION'));
      server.on('checkExpectation', (request, response) => reply(response, 417, 'EXPECTATION'));
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host: HOST, port: 0, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
        });
        session.port = server.address().port;
        session.running = true;
        current = session;
        server.on('error', () => {
          if (current === session) current = null;
          close(session).catch(() => {});
        });
        return snapshot();
      } catch {
        await close(session);
        throw new Error('本机任务状态桥无法启动，请稍后重试。');
      }
    });
  }

  function stop() {
    return enqueue(async () => {
      const session = current;
      current = null;
      await close(session);
      return snapshot();
    });
  }

  return Object.freeze({ start, stop, snapshot });
}

module.exports = { createTaskBridge, validateTaskEvent, MAX_BODY_BYTES, MAX_REQUESTS_PER_MINUTE };
