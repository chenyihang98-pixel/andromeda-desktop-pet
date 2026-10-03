import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../src/settings-ui.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runSettings = new AsyncFunction('window', 'document', source);
const flush = () => new Promise(resolve => setImmediate(resolve));
function element(dataset = {}) {
  const events = new Map(), classes = new Set();
  return {
    dataset, hidden: false, disabled: false, checked: false, value: '', textContent: '', attributes: {}, classes,
    classList: {add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { events.set(name, callback); },
    emit(name, event = {}) { return events.get(name)?.({target: this, ...event}); },
  };
}
async function createSettings({trayAvailable = true, fullscreenAvailable = true, persistenceError = null, apiAvailable = true, failure = null} = {}) {
  const ids = ['status', 'scale', 'scale-value', 'alwaysOnTop', 'gaze', 'edgeDock', 'globalGaze', 'clickThrough', 'autoHideFullscreen', 'fullscreen-help', 'version', 'hide', 'quit', 'reset', 'releases', 'click-through-help', 'desktop-state'];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  const motions = ['still', 'quiet', 'lively'].map(motion => element({motion}));
  const actions = ['wave', 'jump', 'wait', 'review'].map(action => element({action}));
  let state = {settings: {motion: 'quiet', scale: 1.25, alwaysOnTop: true, gaze: false, edgeDock: true, globalGaze: false, clickThrough: false, autoHideFullscreen: false}, visible: true, trayAvailable, fullscreenAvailable, persistenceError, version: '0.2.0', dock: null, clickThroughActive: false};
  let subscriber;
  const calls = [];
  const record = async (method, ...args) => {
    calls.push([method, ...args]);
    if (failure === method) throw new Error('simulated request failure');
    return true;
  };
  const api = {
    async getState() { if (failure === 'getState') throw new Error('simulated load failure'); return state; },
    onState(callback) { subscriber = callback; },
    async setSettings(patch) {
      await record('setSettings', patch);
      state = {...state, settings: {...state.settings, ...patch}};
      subscriber?.(state); return state;
    },
    playAction: (...args) => record('playAction', ...args),
    resetPosition: () => record('resetPosition'),
    hide: () => record('hide'), quit: () => record('quit'),
    openReleases: () => record('openReleases'),
  };
  await runSettings({andromeda: apiAvailable ? api : undefined}, {
    querySelector: selector => elements[selector.slice(1)],
    querySelectorAll: selector => selector === '[data-motion]' ? motions : actions,
  });
  return {
    elements, motions, actions, api, calls,
    update(patch) { state = {...state, ...patch}; subscriber?.(state); },
    state: () => state,
  };
}

test('settings UI exposes v0.2 calm defaults and new toggle preferences', async () => {
  const r = await createSettings();
  assert.equal(r.elements.version.textContent, 'ANDROMEDA · 0.2.0');
  assert.equal(r.elements.edgeDock.checked, true);
  assert.equal(r.elements.globalGaze.checked, false);
  assert.equal(r.elements.clickThrough.checked, false);
  assert.equal(r.elements.clickThrough.disabled, false);
  assert.equal(r.elements['scale-value'].textContent, '125%');
  for (const key of ['gaze', 'globalGaze', 'clickThrough', 'edgeDock', 'autoHideFullscreen']) {
    r.elements[key].checked = !r.elements[key].checked;
    r.elements[key].emit('change'); await flush();
    assert.equal(r.state().settings[key], key !== 'edgeDock');
  }
  assert.equal(r.state().settings.gaze, true, 'Global gaze must preserve the independent local preference');
});

test('fullscreen control exposes capability, recovery and helper failure without changing the default', async () => {
  const r = await createSettings();
  assert.equal(r.elements.autoHideFullscreen.checked, false);
  assert.match(r.elements['fullscreen-help'].textContent, /部分游戏/);
  r.update({fullscreenSuppressed: true});
  assert.match(r.elements['desktop-state'].textContent, /全屏中/);
  r.update({fullscreenSuppressed: false, fullscreenError: '检测失败，已关闭'});
  assert.equal(r.elements['fullscreen-help'].textContent, '检测失败，已关闭');
  for (const options of [{fullscreenAvailable: false}, {trayAvailable: false}]) {
    const unavailable = await createSettings(options);
    assert.equal(unavailable.elements.autoHideFullscreen.disabled, true);
    unavailable.elements.autoHideFullscreen.checked = true;
    unavailable.elements.autoHideFullscreen.emit('change'); await flush();
    assert.equal(unavailable.elements.autoHideFullscreen.checked, false);
    assert.deepEqual(unavailable.calls, []);
    assert.match(unavailable.elements['fullscreen-help'].textContent, /禁用/);
  }
});

test('settings UI disables click-through and hide when no tray is available', async () => {
  const r = await createSettings({trayAvailable: false});
  assert.equal(r.elements.hide.disabled, true);
  assert.equal(r.elements.clickThrough.disabled, true);
  assert.match(r.elements['click-through-help'].textContent, /禁用/);
  r.elements.clickThrough.checked = true; r.elements.clickThrough.emit('change');
  await flush();
  assert.equal(r.elements.clickThrough.checked, false);
  assert.equal(r.calls.length, 0);
  r.update({trayAvailable: true});
  assert.equal(r.elements.clickThrough.disabled, false);
  assert.match(r.elements['click-through-help'].textContent, /关闭穿透并解除停靠/);
});

test('settings UI distinguishes active click-through, dock suspension and collapsed recovery', async () => {
  const r = await createSettings();
  assert.equal(r.elements['desktop-state'].hidden, true);
  r.update({settings: {...r.state().settings, clickThrough: true}, clickThroughActive: true});
  assert.match(r.elements['desktop-state'].textContent, /穿透中/);
  r.update({dock: {edge: 'right', collapsed: false}, clickThroughActive: false});
  assert.match(r.elements['desktop-state'].textContent, /暂时停用/);
  r.update({settings: {...r.state().settings, clickThrough: false}, dock: {edge: 'right', collapsed: true}});
  assert.match(r.elements['desktop-state'].textContent, /星标/);
  r.update({persistenceError: 'disk full'});
  assert.match(r.elements.status.textContent, /无法保存/);
  assert.equal(r.elements.status.classes.has('error'), true);
});

test('settings UI invokes actions, reset, hide and quit without uncaught rejections', async () => {
  const r = await createSettings();
  for (const action of r.actions) action.emit('click');
  for (const id of ['reset', 'hide', 'quit']) r.elements[id].emit('click');
  await flush();
  assert.deepEqual(r.calls, [
    ['playAction', 'wave'], ['playAction', 'jump'], ['playAction', 'wait'], ['playAction', 'review'],
    ['resetPosition'], ['hide'], ['quit'],
  ]);
  for (const [id, method] of [['reset', 'resetPosition'], ['hide', 'hide'], ['quit', 'quit']]) {
    const broken = await createSettings({failure: method});
    broken.elements[id].emit('click'); await flush();
    assert.match(broken.elements.status.textContent, /未能完成/);
  }
});

test('settings UI manual release button only requests its fixed bridge operation, handles repeat and failure', async () => {
  const r = await createSettings();
  let complete;
  r.api.openReleases = () => new Promise(resolve => { r.calls.push(['openReleases']); complete = resolve; });
  const first = r.elements.releases.emit('click');
  assert.equal(r.elements.releases.disabled, true);
  await r.elements.releases.emit('click');
  assert.deepEqual(r.calls, [['openReleases']]);
  complete(true); await first;
  assert.equal(r.elements.releases.disabled, false);
  assert.match(r.elements.status.textContent, /手动查看/);
  const broken = await createSettings({failure: 'openReleases'});
  await broken.elements.releases.emit('click');
  assert.equal(broken.elements.releases.disabled, false);
  assert.match(broken.elements.status.textContent, /未能完成/);
});

test('failed setting restores the prior value, while stale patch responses cannot overwrite a later edit', async () => {
  const broken = await createSettings({failure: 'setSettings'});
  broken.elements.globalGaze.checked = true; broken.elements.globalGaze.emit('change');
  await flush();
  assert.equal(broken.elements.globalGaze.checked, false);
  assert.match(broken.elements.status.textContent, /未能应用/);
  const r = await createSettings(), completions = [];
  r.api.setSettings = patch => new Promise(resolve => completions.push({patch, resolve}));
  r.motions[0].emit('click'); r.motions[2].emit('click');
  completions[1].resolve({...r.state(), settings: {...r.state().settings, motion: 'lively'}});
  await flush();
  completions[0].resolve({...r.state(), settings: {...r.state().settings, motion: 'still'}});
  await flush();
  assert.equal(r.motions[2].attributes['aria-pressed'], 'true');
});

test('settings UI scales labels, applies motion and contains startup failures', async () => {
  const r = await createSettings();
  r.elements.scale.value = '2'; r.elements.scale.emit('input');
  assert.equal(r.elements['scale-value'].textContent, '200%');
  r.elements.scale.emit('change'); r.motions[0].emit('click'); await flush();
  assert.equal(r.state().settings.scale, 2);
  assert.equal(r.state().settings.motion, 'still');
  for (const options of [{apiAvailable: false}, {failure: 'getState'}]) {
    const broken = await createSettings(options);
    assert.match(broken.elements.status.textContent, /Andromeda 应用/);
  }
});

test('preload exposes only fixed commands, argument-free drag messages and sanitized gaze subscriptions', () => {
  const preload = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  let bridge;
  const calls = [], subscriptions = new Map();
  runInNewContext(preload, {require(name) {
    assert.equal(name, 'electron');
    return {
      contextBridge: {exposeInMainWorld(name, value) { assert.equal(name, 'andromeda'); bridge = value; }},
      ipcRenderer: {
        invoke: (...args) => { calls.push(['invoke', ...args]); return Promise.resolve(); },
        send: (...args) => calls.push(['send', ...args]),
        on: (channel, callback) => subscriptions.set(channel, callback),
        removeListener: (channel, callback) => { if (subscriptions.get(channel) === callback) subscriptions.delete(channel); },
      },
    };
  }});
  assert.equal(Object.isFrozen(bridge), true);
  bridge.undock('ignored'); bridge.openReleases('https://untrusted.invalid');
  for (const method of ['startDrag', 'drag', 'endDrag', 'cancelDrag']) bridge[method]({x: 10000, y: 10000});
  assert.deepEqual(calls, [
    ['invoke', 'andromeda:undock'], ['invoke', 'andromeda:open-releases'],
    ['send', 'andromeda:start-drag'], ['send', 'andromeda:drag'], ['send', 'andromeda:end-drag'], ['send', 'andromeda:cancel-drag'],
  ]);
  const received = [], detach = bridge.onGaze((...args) => received.push(args));
  const value = {x: 10, y: -20};
  subscriptions.get('andromeda:gaze')({secret: true}, value);
  assert.deepEqual(received, [[value]]);
  detach(); assert.equal(subscriptions.has('andromeda:gaze'), false);
  assert.throws(() => bridge.onGaze('invalid'), /回调必须是函数/);
});
