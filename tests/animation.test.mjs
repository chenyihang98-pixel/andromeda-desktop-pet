import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {frameAt, neutralDelay, gazeCell, cropRect, ACTIONS} from '../src/animation.mjs';
const manifest = JSON.parse(readFileSync(new URL('../assets/manifest.json', import.meta.url)));
test('nine states preserve exact geometry and 57 standard frames', () => {
  assert.equal(Object.keys(manifest.animations).length, 9);
  assert.equal(Object.values(manifest.animations).reduce((n,a) => n + a.frameCount,0),57);
  for(const a of Object.values(manifest.animations)) assert.equal(a.frameCount, a.durationsMs.length);
});
test('frame timing is exact at boundaries and stops instead of looping', () => {
  const a = manifest.animations.waving;
  assert.equal(frameAt(a,0).column,0); assert.equal(frameAt(a,139).column,0);
  assert.equal(frameAt(a,140).column,1); assert.equal(frameAt(a,699).column,3); assert.equal(frameAt(a,700),null);
  assert.equal(frameAt(a,209,1.5).column,0); assert.equal(frameAt(a,210,1.5).column,1);
  assert.equal(frameAt(a,NaN),null); assert.equal(frameAt(a,-5).column,0);
});
test('quiet mode holds 45–90s, still has no timer, lively holds 12–20s', () => {
  assert.equal(neutralDelay('quiet',()=>0),45000); assert.equal(neutralDelay('quiet',()=>1),90000);
  assert.equal(neutralDelay('still'),null); assert.equal(neutralDelay('lively',()=>0),12000);
  assert.equal(neutralDelay('lively',()=>1),20000); assert.equal(neutralDelay('bad',()=>-2),45000);
});
test('look directions use screen coordinates with neutral deadzone', () => {
  assert.deepEqual(gazeCell(0,-100),{row:9,column:0}); assert.deepEqual(gazeCell(100,0),{row:9,column:4});
  assert.deepEqual(gazeCell(0,100),{row:10,column:0}); assert.deepEqual(gazeCell(-100,0),{row:10,column:4});
  assert.deepEqual(gazeCell(0,0),{row:0,column:0}); assert.deepEqual(gazeCell(NaN,0),{row:0,column:0});
  assert.deepEqual(gazeCell(100,-100),{row:9,column:2}); assert.deepEqual(gazeCell(-100,100),{row:10,column:2});
});
test('crop bounds reject invalid indices and preserve atlas registration', () => {
  assert.deepEqual(cropRect(manifest.atlas,10,7),[1344,2080,192,208]);
  assert.throws(()=>cropRect(manifest.atlas,11,0),RangeError); assert.throws(()=>cropRect(manifest.atlas,0,-1),RangeError);
  assert.throws(()=>cropRect(manifest.atlas,0,0.5),RangeError);
});
test('interaction actions never request locomotion', () => {
  assert.deepEqual(Object.keys(ACTIONS),['wave','jump','wait','review']);
  assert.equal(manifest.desktopPlayback.automaticWalking,false); assert.equal(manifest.desktopPlayback.automaticBlink,false);
});
