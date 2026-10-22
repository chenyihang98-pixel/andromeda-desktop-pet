import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PNG} from 'pngjs';
import {characterPackFromAtlas} from '../src/shared/character.mjs';
import {parseCharacterJSON, setGroundAnchor, previewFrame, setAnimation, setGrid, inspectImageBytes} from '../src/character-editor.mjs';
const fixture = () => characterPackFromAtlas(JSON.parse(readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8')));

test('editor JSON is bounded data and rejects executable/external paths before rendering', () => {
  const pack = fixture();assert.deepEqual(parseCharacterJSON(JSON.stringify(pack)), pack);
  for (const path of ['https://example.test/a.png', '../a.png', 'file:///a.png', 'data:image/svg+xml,test']) {
    assert.throws(() => parseCharacterJSON(JSON.stringify({...pack, atlas: {...pack.atlas, image: path}})));
  }
  assert.throws(() => parseCharacterJSON(JSON.stringify({...pack, script: 'alert(1)'})));
  assert.throws(() => parseCharacterJSON(' '.repeat(65537)));
  assert.throws(() => parseCharacterJSON('界'.repeat(22000)));
});

test('visual anchor and animation edits validate atomically without mutating the caller pack', () => {
  const pack = fixture(), before = JSON.stringify(pack);
  assert.deepEqual(setGroundAnchor(pack, .25, .754321).anchors.ground, {x: .25, y: .7543});
  assert.throws(() => setGroundAnchor(pack, -1, .5));
  assert.throws(() => setGroundAnchor(pack, .5, Infinity));
  const next = setAnimation(pack, {name: 'wave-test', row: 3, frameCount: 2, durations: '80'});
  assert.deepEqual(next.animations['wave-test'].durationsMs, [80, 80]);
  assert.throws(() => setAnimation(pack, {name: 'wave-test', row: 999, frameCount: 2, durations: '80'}));
  assert.throws(() => setAnimation(pack, {name: 'wave-test', row: 3, frameCount: 2, durations: '80, 90, 100'}));
  assert.throws(() => setAnimation(pack, {name: 'wave-test', row: 3, frameCount: 2, durations: '15'}));
  assert.equal(JSON.stringify(pack), before);
});

test('preview follows per-frame time, loops deterministically and reduced motion stays static', () => {
  const pack = fixture();
  assert.equal(previewFrame(pack, 'greet', 139).column, 0);
  assert.equal(previewFrame(pack, 'greet', 140).column, 1);
  assert.equal(previewFrame(pack, 'greet', 700).column, 0);
  assert.equal(previewFrame(pack, 'greet', 200, true).column, 0);
  assert.equal(previewFrame(pack, 'greet', 200, true).static, true);
  assert.equal(previewFrame(pack, 'sleep', 0).fallback, true);
  assert.throws(() => previewFrame(pack, 'greet', -1));
});

test('changing grid rejects nonintegral cells and layouts that invalidate existing clips', () => {
  const pack = fixture();assert.deepEqual(setGrid(pack, 8, 11), pack);
  assert.throws(() => setGrid(pack, 7, 11));
  assert.throws(() => setGrid(pack, 8, 2));
  assert.throws(() => setGrid(pack, 0, 11));
});

test('image inspection checks file signature, dimensions and WebP animation before decode', () => {
  const png = new PNG({width: 16, height: 8}), bytes = PNG.sync.write(png);
  assert.deepEqual(inspectImageBytes(bytes), {width: 16, height: 8, mime: 'image/png'});
  assert.throws(()=>inspectImageBytes(bytes.subarray(0,24)),/PNG/);
  const animated=Buffer.from(bytes);animated.write('acTL',37);assert.throws(()=>inspectImageBytes(animated),/动画 PNG/);
  assert.throws(() => inspectImageBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')));
  const bad = Buffer.from(bytes);bad.writeUInt32BE(20000, 16);assert.throws(() => inspectImageBytes(bad));
  const webp = Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22, 4);webp.write('WEBP', 8);webp.write('VP8X', 12);webp.writeUInt32LE(10, 16);webp[24] = 15;webp[27] = 7;
  assert.deepEqual(inspectImageBytes(webp), {width: 16, height: 8, mime: 'image/webp'});
  webp[20] = 2;assert.throws(() => inspectImageBytes(webp), /动画 WebP/);
});
