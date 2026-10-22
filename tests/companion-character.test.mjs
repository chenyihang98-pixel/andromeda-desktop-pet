import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { characterPackFromAtlas, validateCharacterPack, resolveAction, createActionResolver } from '../src/shared/character.mjs';

const atlas = JSON.parse(await readFile(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

test('prepared resolution owns validated metadata and returns detached clips', () => {
  const pack = characterPackFromAtlas(atlas), expected = resolveAction(pack, 'greet'), resolve = createActionResolver(pack);
  pack.actions.greet = 'idle';pack.animations.waving.durationsMs[0] = -1;
  assert.deepEqual(resolve('greet'), expected);
  const first = resolve('greet');first.durationsMs[0] = -2;first.anchor.y = -3;
  assert.deepEqual(resolve('greet'), expected);
  assert.equal(resolve('greet', {reducedMotion: true}).frameCount, 1);
  assert.throws(() => createActionResolver(pack));
  assert.throws(() => resolve('../bad'));
  assert.throws(() => resolve('greet', {reducedMotion: 'yes'}));
});

test('current atlas wraps without editing its layout, identity or source rights', () => {
  const original = clone(atlas), pack = characterPackFromAtlas(atlas);
  assert.deepEqual(atlas, original); assert.equal(pack.source.license, 'UNLICENSED'); assert.equal(pack.atlas.width, 1536);
  assert.equal(pack.lookDirections.degreesClockwise.length, 16); assert.equal(pack.sha256, atlas.sha256);
  const greeting = resolveAction(pack, 'greet'); assert.equal(greeting.animation, 'waving'); assert.equal(greeting.fallback, false);
});

test('missing poses degrade explicitly to existing assets, including static reduced motion', () => {
  const pack = characterPackFromAtlas(atlas);
  const sleep = resolveAction(pack, 'sleep'); assert.equal(sleep.animation, 'waiting'); assert.equal(sleep.fallback, true);
  const reduced = resolveAction(pack, 'happy', { reducedMotion: true }); assert.equal(reduced.static, true); assert.equal(reduced.frameCount, 1);
  const unknown = resolveAction(pack, 'constructor'); assert.equal(unknown.animation, 'idle'); assert.equal(unknown.fallback, true);
  const sparse = clone(pack); sparse.actions = {}; sparse.animations = { waving: pack.animations.waving };
  const neutral = resolveAction(sparse, 'sleep'); assert.equal(neutral.animation, null); assert.equal(neutral.static, true); assert.equal(neutral.row, 0);
});

test('untrusted character packs reject external paths, traversal, invalid animation geometry and executable fields', () => {
  const pack = characterPackFromAtlas(atlas);
  for (const image of ['https://example.com/pet.png', '../pet.png', 'folder/%2e%2e/pet.png', 'file:///pet.png', 'pet.svg']) {
    const bad = clone(pack); bad.atlas.image = image; assert.throws(() => validateCharacterPack(bad));
  }
  const malformed = clone(pack); malformed.animations.idle.frameCount = 99; assert.throws(() => validateCharacterPack(malformed));
  const duration = clone(pack); duration.animations.idle.durationsMs[0] = 0; assert.throws(() => validateCharacterPack(duration));
  const anchor = clone(pack); anchor.anchors.ground.x = 1.1; assert.throws(() => validateCharacterPack(anchor));
  const script = clone(pack); script.script = 'run()'; assert.throws(() => validateCharacterPack(script));
  let accessed = false; const accessor = clone(pack); Object.defineProperty(accessor, 'name', { get() { accessed = true; return 'bad'; } });
  assert.throws(() => validateCharacterPack(accessor)); assert.equal(accessed, false);
});
