import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomCharacter} from '../src/custom-character.mjs';

const pack = () => ({schema: 'andromeda.character/v1', id: 'test-pet', name: 'Test pet', version: '1',
  source: {kind: 'original', author: 'Test', license: 'Test', reference: 'Test'},
  atlas: {image: 'pet.png', width: 60, height: 160, columns: 3, rows: 4, cellWidth: 20, cellHeight: 40},
  neutral: {row: 3, column: 1}, animations: {idle: {row: 0, frameCount: 1, durationsMs: [50]},
    waving: {row: 1, frameCount: 3, durationsMs: [20, 30, 40]}}, actions: {greet: 'waving'},
  lookDirections: {rows: [2, 3], degreesClockwise: [350, 70, 110, 190, 250]},
  anchors: {ground: {x: 0.25, y: 0.9}, dialogue: {x: 0.8, y: 0.2}}});
const dataURL = 'data:image/png;base64,AQIDBA==';
class Target {
  listeners = new Map();
  addEventListener(type, listener) {if (!this.listeners.has(type)) this.listeners.set(type, new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type, listener) {this.listeners.get(type)?.delete(listener);}
  fire(type) {for (const listener of this.listeners.get(type) ?? []) listener();}
}
function environment({width = 100, height = 100, systemReduce = false} = {}) {
  let now = 0, counter = 0;
  const timers = new Map(), images = [], canvases = [], doc = new Target(), motion = new Target();
  motion.matches = systemReduce;doc.hidden = false;
  const context = () => ({calls: [], last: null, arcs: 0,
    clearRect() {this.last = null;this.calls.push(['clear']);},
    drawImage(...args) {this.last = args;this.calls.push(args);},
    save() {}, restore() {}, setTransform() {}, beginPath() {}, arc() {this.arcs++;}, stroke() {}, fillText() {},
    getImageData(x, y) {
      const a = this.last;const inside = a?.length === 9 && x >= a[5] + a[7] / 2 && x < a[5] + a[7] && y >= a[6] && y < a[6] + a[8];
      return {data: new Uint8ClampedArray([0, 0, 0, inside ? 255 : 0])};
    }});
  const makeCanvas = () => {const ctx = context(), canvas = {width, height, ownerDocument: doc, ctx, getContext: () => ctx};canvases.push(canvas);return canvas;};
  doc.createElement = name => {assert.equal(name, 'canvas');return makeCanvas();};
  doc.defaultView = {performance: {now: () => now}, matchMedia: () => motion,
    setTimeout(callback, delay) {const id = ++counter;timers.set(id, {callback, at: now + delay});return id;},
    clearTimeout(id) {timers.delete(id);},
    Image: class {constructor() {images.push(this);}removeAttribute(name) {assert.equal(name, 'src');this.src = '';}}};
  const canvas = makeCanvas();
  return {doc, motion, canvas, canvases, images, timers,
    load(width = 60, height = 160) {const image = images.at(-1);image.naturalWidth = width;image.naturalHeight = height;image.onload?.();},
    tick(ms) {const target = now + ms;for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;now = next[1].at;timers.delete(next[0]);next[1].callback();
    }now = target;},
    create(options = {}) {return createCustomCharacter({canvas, pack: pack(), imageDataURL: dataURL, ...options});},
    crop() {return canvases[1].ctx.last?.slice(1, 5);},
  };
}

test('arbitrary cell size and neutral coordinates preserve aspect ratio and expose canvas anchors', async () => {
  const env = environment(), renderer = env.create();env.load();assert.equal(await renderer.ready, true);
  assert.deepEqual(env.crop(), [20, 120, 20, 40]);
  assert.deepEqual(env.canvases[1].ctx.last.slice(5), [25, 0, 50, 100]);
  assert.deepEqual(renderer.anchors().ground, {x: 37.5, y: 90});
  assert.deepEqual(renderer.anchors().dialogue, {x: 65, y: 20});
  assert.equal(env.canvas.width, 100);assert.equal(env.canvas.height, 100);
  const anchors = renderer.anchors();anchors.ground.x = -1;assert.equal(renderer.anchors().ground.x, 37.5);
  renderer.destroy();
});
test('semantic playback respects uneven durations, fallback and natural return to neutral', async () => {
  const env = environment(), renderer = env.create();env.load();await renderer.ready;
  assert.equal(renderer.draw('greet').animation, 'waving');assert.deepEqual(env.crop(), [0, 40, 20, 40]);
  env.tick(19);assert.deepEqual(env.crop(), [0, 40, 20, 40]);
  env.tick(1);assert.deepEqual(env.crop(), [20, 40, 20, 40]);
  env.tick(30);assert.deepEqual(env.crop(), [40, 40, 20, 40]);
  env.tick(40);assert.deepEqual(env.crop(), [20, 120, 20, 40]);assert.equal(env.timers.size, 0);
  assert.equal(renderer.draw('unknown-action').animation, 'idle');renderer.neutral();assert.equal(env.timers.size, 0);
  renderer.destroy();
});
test('gaze uses nearest declared angle and the pack grid rather than the classic atlas', async () => {
  const env = environment(), renderer = env.create();env.load();await renderer.ready;
  renderer.gaze(-100, 0);assert.deepEqual(env.crop(), [20, 120, 20, 40]); // 250 degrees -> row 3, column 1
  renderer.gaze(100, 0);assert.deepEqual(env.crop(), [20, 80, 20, 40]); // tie resolves to declared 70 degrees
  renderer.gaze(0, -100);assert.deepEqual(env.crop(), [0, 80, 20, 40]); // circular nearest 350 degrees
  renderer.draw('greet');assert.equal(renderer.gaze(100, 0), false);assert.deepEqual(env.crop(), [0, 40, 20, 40]);
  renderer.stop();renderer.gaze(1, 1);assert.deepEqual(env.crop(), [20, 120, 20, 40]);
  assert.equal(renderer.gaze(NaN, 3), false);renderer.destroy();
});
test('reduced motion holds a pose without timers, honours OS preference and never resumes stopped actions', async () => {
  const env = environment(), renderer = env.create();env.load();await renderer.ready;
  renderer.draw('greet');env.tick(20);renderer.setReducedMotion(true);
  assert.equal(env.timers.size, 0);assert.deepEqual(env.crop(), [0, 40, 20, 40]);
  renderer.gaze(100, 0);assert.deepEqual(env.crop(), [20, 120, 20, 40]);
  renderer.setReducedMotion(false);assert.equal(env.timers.size, 0);
  renderer.draw('greet');env.motion.matches = true;env.motion.fire('change');assert.equal(env.timers.size, 0);
  assert.deepEqual(env.crop(), [0, 40, 20, 40]);env.motion.matches = false;env.motion.fire('change');assert.equal(env.timers.size, 0);
  renderer.destroy();
});
test('hit testing uses only artwork alpha and excludes anchors, transparent pixels and bounds', async () => {
  const env = environment(), renderer = env.create({showAnchors: true});assert.equal(renderer.hitTest(70, 50), false);
  env.load();await renderer.ready;assert.equal(env.canvas.ctx.arcs, 4);assert.equal(env.canvases[1].ctx.arcs, 0);
  assert.equal(renderer.hitTest(70, 50), true);assert.equal(renderer.hitTest(30, 50), false);
  for (const [x, y] of [[-1, 1], [100, 1], [70, 100], [NaN, 1], [Infinity, 1]]) assert.equal(renderer.hitTest(x, y), false);
  env.canvases[1].ctx.getImageData = () => {throw new Error('unreadable');};assert.equal(renderer.hitTest(70, 50), false);
  renderer.destroy();assert.equal(renderer.hitTest(70, 50), false);
});
test('queued action loads once; stop and hidden state cancel pending or running animation', async () => {
  const env = environment(), renderer = env.create();renderer.draw('greet');env.load();await renderer.ready;
  assert.deepEqual(env.crop(), [0, 40, 20, 40]);const stale = [...env.timers.values()][0].callback;
  renderer.stop();stale();assert.equal(env.timers.size, 0);assert.deepEqual(env.crop(), [0, 40, 20, 40]);
  renderer.draw('greet');env.doc.hidden = true;env.doc.fire('visibilitychange');assert.equal(env.timers.size, 0);
  assert.deepEqual(env.crop(), [20, 120, 20, 40]);env.doc.hidden = false;env.doc.fire('visibilitychange');assert.equal(env.timers.size, 0);
  renderer.destroy();
  const second = environment(), stopped = second.create();stopped.draw('greet');stopped.stop();second.load();await stopped.ready;
  assert.equal(second.canvases[1].ctx.calls.length, 0);assert.equal(second.timers.size, 0);stopped.destroy();
});
test('destroy settles pending decode, ignores late image callbacks and releases timers/listeners/pixels', async () => {
  const env = environment(), renderer = env.create(), late = env.images[0].onload;
  renderer.destroy();assert.equal(await renderer.ready, false);late();
  assert.equal(env.canvases[1].width, 0);assert.equal(env.canvases[1].height, 0);
  assert.equal(env.doc.listeners.get('visibilitychange').size, 0);assert.equal(env.motion.listeners.get('change').size, 0);
  assert.equal(renderer.draw('greet'), null);assert.equal(renderer.neutral(), false);renderer.destroy();
  const loaded = environment(), active = loaded.create();loaded.load();await active.ready;active.draw('greet');active.destroy();assert.equal(loaded.timers.size, 0);
});
test('remote sources, invalid image sizes/formats and failed decode never become rendered artwork', async () => {
  const env = environment();
  for (const imageDataURL of ['https://example.test/a.png', 'file:///a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,A', 'data:image/png;base64,', 'data:image/png;base64,' + 'A'.repeat(11_200_000)]) {
    assert.throws(() => env.create({imageDataURL}), /角色图片/);
  }
  assert.equal(env.images.length, 0);
  const wrong = env.create();env.load(120, 160);await assert.rejects(wrong.ready, /尺寸/);assert.equal(wrong.hitTest(70, 50), false);wrong.destroy();
  const failedEnv = environment(), failed = failedEnv.create();failedEnv.images[0].onerror();await assert.rejects(failed.ready, /解码/);failed.destroy();
});
test('supplied metadata is cloned and legal maximum cell sizes are displayed within existing canvas', async () => {
  const env = environment({width: 200, height: 100}), input = pack();
  input.atlas = {image: 'pet.webp', width: 4096, height: 4096, columns: 1, rows: 1, cellWidth: 4096, cellHeight: 4096};
  input.neutral = {row: 0, column: 0};input.animations = {idle: {row: 0, frameCount: 1, durationsMs: [16]}};input.actions = {};delete input.lookDirections;
  const renderer = env.create({pack: input});input.atlas.cellWidth = 1;env.load(4096, 4096);await renderer.ready;
  assert.deepEqual(env.crop(), [0, 0, 4096, 4096]);assert.deepEqual(env.canvases[1].ctx.last.slice(5), [50, 0, 100, 100]);
  renderer.destroy();
});

test('same gaze cell and repeated preferences do not redraw; canvas resize invalidates cache', async () => {
  const env=environment(),renderer=env.create();env.load();await renderer.ready;
  renderer.gaze(100,-10);const painted=env.canvas.ctx.calls.length;
  for(let i=0;i<20;i++){renderer.gaze(100+i,-10);renderer.setReducedMotion(false);}
  assert.equal(env.canvas.ctx.calls.length,painted);
  env.canvas.width=200;renderer.gaze(100,0);assert.ok(env.canvas.ctx.calls.length>painted);
  renderer.draw('greet');renderer.setReducedMotion(true);const reducedPaints=env.canvas.ctx.calls.length;
  for(let i=0;i<20;i++)renderer.setReducedMotion(true);
  assert.equal(env.canvas.ctx.calls.length,reducedPaints);assert.equal(env.timers.size,0);
  renderer.destroy();
});
