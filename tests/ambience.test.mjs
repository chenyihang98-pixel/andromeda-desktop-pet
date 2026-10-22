import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAmbience, MAX_AMBIENCE_BYTES } from '../src/ambience-ui.mjs';

class Hub {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type, extra = {}) { for (const callback of [...(this.listeners.get(type) || [])]) callback({ type, ...extra }); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
}
class Element extends Hub {
  constructor(document, tag) { super(); this.ownerDocument = document; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; this.files = []; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const audioFile = (overrides = {}) => ({name: 'private-local-song.mp3', type: 'audio/mpeg', size: 16, arrayBuffer: async () => new ArrayBuffer(16), ...overrides});

function fixture(t, {decode, reduced = false, onLevel} = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), contexts = [], levels = [], media = new Hub(); media.matches = reduced;
  const document = new Hub(); document.hidden = false;
  const view = new Hub(); document.defaultView = view;
  document.createElement = tag => new Element(document, tag);
  Object.assign(view, {
    matchMedia: () => media,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, {callback, at: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { throw new Error('No network allowed'); },
    navigator: {mediaDevices: {getUserMedia() { throw new Error('No microphone allowed'); }}},
  });
  const state = {amplitude: 0.3};
  class Node {
    connections = []; disconnected = 0;
    connect(node) { this.connections.push(node); }
    disconnect() { this.disconnected += 1; this.connections = []; }
  }
  class FakeAudioContext {
    state = 'suspended'; destination = {}; nodes = []; sources = []; resumeCount = 0; suspendCount = 0; closeCount = 0; decodeCount = 0;
    constructor() { contexts.push(this); }
    get currentTime() { return now / 1000; }
    async resume() { this.resumeCount += 1; this.state = 'running'; }
    async suspend() { this.suspendCount += 1; this.state = 'suspended'; }
    async close() { this.closeCount += 1; this.state = 'closed'; }
    async decodeAudioData(bytes) { this.decodeCount += 1; return decode ? decode(bytes, this) : {duration: 30}; }
    createGain() { const node = new Node(); node.gain = {value: 1}; this.nodes.push(node); return node; }
    createAnalyser() { const node = new Node(); node.getFloatTimeDomainData = values => values.fill(state.amplitude); this.nodes.push(node); return node; }
    createBufferSource() {
      const node = new Node(); node.starts = []; node.stops = 0;
      node.start = (...args) => node.starts.push(args);
      node.stop = () => { node.stops += 1; node.onended?.(); };
      node.finish = () => node.onended?.();
      this.sources.push(node); this.nodes.push(node); return node;
    }
  }
  view.AudioContext = FakeAudioContext;
  const root = new Element(document, 'div');
  const widget = mountAmbience({ root, onLevel: value => { levels.push({at: now, value}); onLevel?.(value); } });
  t.after(() => widget.destroy());
  function find(role, node = root) { if (node.dataset.ambience === role) return node; for (const child of node.children) { const found = find(role, child); if (found) return found; } return null; }
  function choose(file) { const input = find('file'); input.files = file ? [file] : []; input.dispatch('change'); }
  const click = role => find(role).dispatch('click');
  function advance(ms) {
    const end = now + ms;
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer.at > end) break;
      now = timer.at; timers.delete(id); timer.callback();
    }
    now = end;
  }
  return {widget, root, document, view, media, contexts, levels, state, timers, find, choose, click, advance};
}

test('mount and file selection do not decode, play, request microphone or fetch data', async t => {
  const f = fixture(t);
  let reads = 0;
  assert.deepEqual(f.widget.snapshot(), {status: 'idle', hasFile: false, volume: 0.35, reducedMotion: false, level: 0});
  f.choose(audioFile({arrayBuffer: async () => { reads += 1; return new ArrayBuffer(16); }}));
  await flush(); f.advance(1000);
  assert.equal(reads, 0); assert.equal(f.contexts.length, 0); assert.equal(f.widget.snapshot().status, 'ready');
  assert.equal(JSON.stringify(f.widget.snapshot()).includes('private-local-song'), false);
  assert.ok(f.levels.every(event => typeof event.value === 'number' && event.value === 0));
});

test('active playback emits only bounded scalar amplitude at no more than 10 Hz', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Audio must never request the network'); });
  const f = fixture(t); f.choose(audioFile()); f.click('play'); await flush();
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].decodeCount, 1);
  assert.equal(f.contexts[0].sources[0].starts.length, 1);
  assert.equal(f.widget.snapshot().status, 'playing');
  for (let i = 0; i < 10; i++) { f.state.amplitude = 0.02 + i * 0.04; f.advance(100); }
  const active = f.levels.filter(event => event.value > 0);
  assert.equal(active.length, 10);
  assert.ok(active.every(event => Number.isFinite(event.value) && event.value >= 0 && event.value <= 1));
  for (let i = 1; i < active.length; i++) assert.ok(active[i].at - active[i - 1].at >= 100);
  f.state.amplitude = 100; f.advance(100); assert.equal(f.levels.at(-1).value, 1);
  f.state.amplitude = NaN; f.advance(100); assert.equal(f.levels.at(-1).value, 0);
  f.widget.stop(); assert.equal(f.levels.at(-1).value, 0); assert.equal(f.timers.size, 0);
});

test('pause resumes at the saved offset without re-decoding, and volume only changes its own gain', async t => {
  const f = fixture(t); f.choose(audioFile()); f.click('play'); await flush();
  const context = f.contexts[0]; f.advance(2500); f.click('pause');
  assert.equal(f.widget.snapshot().status, 'paused'); assert.equal(context.suspendCount, 1);
  assert.equal(context.sources[0].stops, 1); assert.equal(f.levels.at(-1).value, 0);
  f.advance(5000); f.click('play'); await flush();
  assert.deepEqual(context.sources[1].starts, [[0, 2.5]]); assert.equal(context.decodeCount, 1);
  f.find('volume').value = '0.8'; f.find('volume').dispatch('input');
  assert.equal(context.nodes[0].gain.value, 0.8); assert.equal(f.widget.snapshot().volume, 0.8);
  f.find('volume').value = '0'; f.find('volume').dispatch('input'); f.advance(100);
  assert.equal(f.levels.at(-1).value, 0); assert.equal(f.widget.snapshot().status, 'playing');
});

test('stop during a late decode prevents starting or overwriting a replacement track', async t => {
  const pending = [];
  const f = fixture(t, {decode: () => new Promise(resolve => pending.push(resolve))});
  f.choose(audioFile()); f.click('play'); await flush();
  assert.equal(f.widget.snapshot().status, 'loading');
  const first = f.contexts[0];
  f.widget.stop(); assert.equal(first.closeCount, 1);
  f.choose(audioFile({name: 'replacement.wav', type: 'audio/wav'})); f.click('play'); await flush();
  const second = f.contexts[1]; pending[1]({duration: 15}); await flush();
  assert.equal(f.widget.snapshot().status, 'playing');
  pending[0]({duration: 999}); await flush();
  assert.equal(first.sources.length, 0); assert.equal(second.sources.length, 1);
  assert.equal(second.sources[0].buffer.duration, 15); assert.equal(f.widget.snapshot().status, 'playing');
});

test('switching a playing track releases the old graph and never autoplays the new file', async t => {
  const f = fixture(t); f.choose(audioFile()); f.click('play'); await flush();
  f.advance(100); const first = f.contexts[0];
  f.choose(audioFile({name: 'second.ogg', type: 'audio/ogg'}));
  assert.equal(f.widget.snapshot().status, 'ready'); assert.equal(first.closeCount, 1);
  assert.equal(first.sources[0].stops, 1); assert.ok(first.nodes.every(node => node.disconnected === 1));
  assert.equal(f.contexts.length, 1); assert.equal(f.levels.at(-1).value, 0); assert.equal(f.timers.size, 0);
});

test('size, type and actual byte limits reject files before decoding or release on inconsistent input', async t => {
  const f = fixture(t); let reads = 0;
  for (const overrides of [{size: MAX_AMBIENCE_BYTES + 1}, {size: 0}, {name: 'script.exe'}, {type: 'video/mp4'}, {name: 'track.mp3.exe'}]) {
    f.choose(audioFile({...overrides, arrayBuffer: async () => { reads += 1; return new ArrayBuffer(16); }}));
    f.click('play'); await flush(); assert.equal(f.widget.snapshot().status, 'error'); assert.equal(f.widget.snapshot().hasFile, false);
  }
  assert.equal(reads, 0); assert.equal(f.contexts.length, 0);
  f.choose(audioFile({arrayBuffer: async () => new ArrayBuffer(MAX_AMBIENCE_BYTES + 1)}));
  f.click('play'); await flush();
  assert.equal(f.contexts[0].decodeCount, 0); assert.equal(f.contexts[0].closeCount, 1);
  assert.equal(f.widget.snapshot().status, 'error');
});

test('natural end, hiding and page lifecycle stop playback and synchronously clear movement', async t => {
  for (const finish of [f => f.contexts[0].sources[0].finish(), f => { f.document.hidden = true; f.document.dispatch('visibilitychange'); },
    f => f.view.dispatch('pagehide')]) {
    const f = fixture(t); f.choose(audioFile()); f.click('play'); await flush(); f.advance(100);
    assert.ok(f.levels.at(-1).value > 0); finish(f);
    assert.equal(f.levels.at(-1).value, 0); assert.equal(f.contexts[0].closeCount, 1);
    assert.equal(f.timers.size, 0); assert.equal(f.widget.snapshot().status, 'stopped');
    f.document.hidden = false; f.document.dispatch('visibilitychange'); await flush();
    assert.equal(f.contexts.length, 1, 'Showing the panel never resumes music automatically');
  }
});

test('reduced motion and the system preference stop only movement while audio continues', async t => {
  const f = fixture(t); f.choose(audioFile()); f.click('play'); await flush(); f.advance(100);
  f.find('reduced-motion').checked = true; f.find('reduced-motion').dispatch('change');
  assert.equal(f.widget.snapshot().reducedMotion, true); assert.equal(f.levels.at(-1).value, 0);
  assert.equal(f.contexts[0].sources[0].stops, 0); assert.equal(f.contexts[0].closeCount, 0);
  assert.equal(f.widget.snapshot().status, 'playing'); assert.equal(f.timers.size, 0);
  f.find('reduced-motion').checked = false; f.find('reduced-motion').dispatch('change'); f.advance(100);
  assert.ok(f.levels.at(-1).value > 0);
  f.media.matches = true; f.media.dispatch('change', {matches: true});
  assert.equal(f.levels.at(-1).value, 0); assert.equal(f.widget.snapshot().status, 'playing');
  assert.equal(f.find('reduced-motion').disabled, true);
});

test('destroy releases resources/listeners, zeros the host and ignores a pending decode', async t => {
  let resolveDecode;
  const f = fixture(t, {decode: () => new Promise(resolve => { resolveDecode = resolve; })});
  f.choose(audioFile()); f.click('play'); await flush();
  f.widget.destroy();
  assert.equal(f.widget.snapshot().status, 'destroyed'); assert.equal(f.widget.snapshot().hasFile, false);
  assert.equal(f.root.children.length, 0); assert.equal(f.document.listenerCount, 0); assert.equal(f.view.listenerCount, 0); assert.equal(f.media.listenerCount, 0);
  assert.equal(f.contexts[0].closeCount, 1); assert.equal(f.timers.size, 0); assert.equal(f.levels.at(-1).value, 0);
  resolveDecode({duration: 10}); await flush();
  assert.equal(f.contexts[0].sources.length, 0); assert.equal(f.widget.snapshot().status, 'destroyed');
  f.widget.destroy(); f.widget.stop(); assert.equal(f.contexts[0].closeCount, 1);
});

test('decode failures are generic, and host callback exceptions cannot prevent stop cleanup', async t => {
  const f = fixture(t, {decode: async () => { throw new Error('private-local-song.mp3 / private-path'); },
    onLevel: () => { throw new Error('host unavailable'); }});
  f.choose(audioFile()); f.click('play'); await flush();
  assert.equal(f.widget.snapshot().status, 'error'); assert.equal(f.contexts[0].closeCount, 1);
  assert.equal(f.find('status').textContent.includes('private'), false);
  f.widget.stop(); assert.equal(f.levels.at(-1).value, 0);
});
