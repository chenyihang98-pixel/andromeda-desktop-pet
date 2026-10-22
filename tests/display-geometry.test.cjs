'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { petSize, fitSizeToArea, clampPosition, defaultPosition } = require('../src/settings.cjs');
const { dockBounds } = require('../src/docking.cjs');

const resolutions = [[1280, 720], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160], [720, 1280], [1080, 1920], [1440, 2560]];
const dpis = [1, 1.25, 1.5, 1.75, 2];
const scales = [0.75, 1, 1.25, 1.5, 1.75, 2];

function contained(bounds, area, label) {
  assert.ok(Object.values(bounds).every(Number.isInteger), label);
  assert.ok(bounds.width >= 1 && bounds.height >= 1, label);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y, label);
  assert.ok(bounds.x + bounds.width <= area.x + area.width, label);
  assert.ok(bounds.y + bounds.height <= area.y + area.height, label);
}

test('1,440 simulated resolution/DPI/scale/work-area combinations preserve ratio and containment', () => {
  let combinations = 0;
  for (const [physicalWidth, physicalHeight] of resolutions) {
    for (const scaleFactor of dpis) for (const scale of scales) {
      for (const [x, y] of [[0, 0], [-2560, -240], [1920, 120]]) for (const taskbar of ['bottom', 'left']) {
        // Only this fixture converts physical resolution to Electron-style DIP.
        // Production geometry receives workArea directly and never uses DPR.
        const width = Math.floor(physicalWidth / scaleFactor), height = Math.floor(physicalHeight / scaleFactor);
        const area = taskbar === 'left' ? {x: x + 48, y, width: width - 48, height} : {x, y, width, height: height - 48};
        const display = {id: 7, scaleFactor, workArea: area};
        const label = `${physicalWidth}x${physicalHeight} DPI=${scaleFactor} scale=${scale} ${taskbar} ${x},${y}`;
        const size = petSize(scale, display), nominal = petSize(scale);
        assert.ok(size.width <= nominal.width && size.height <= nominal.height, label);
        // Each integral DIP dimension may round by at most half a pixel.
        assert.ok(Math.abs(size.width * 13 - size.height * 12) <= 12.5, label);
        if (nominal.width <= area.width && nominal.height <= area.height) assert.deepEqual(size, nominal, label);
        const restored = petSize(scale, {workArea: {x: 0, y: 0, width: 3840, height: 2160}});
        assert.deepEqual(restored, nominal, 'A temporary fit must not change the requested scale');
        assert.deepEqual(petSize(scale, {...display, scaleFactor: scaleFactor * 3}), size, 'DIP must not be multiplied by DPR');
        const position = clampPosition({x: x + width + 500, y: y + height + 500}, size, [display]);
        contained({...position, ...size}, area, label);
        contained({...defaultPosition(size, display), ...size}, area, label);
        for (const edge of ['left', 'right', 'top', 'bottom']) {
          const layout = dockBounds({displayId: display.id, edge, ratio: 0.73}, nominal, [display]);
          contained(layout.expanded, area, label);
          contained(layout.collapsed, area, label);
          assert.deepEqual({width: layout.expanded.width, height: layout.expanded.height}, size, label);
        }
        combinations += 1;
      }
    }
  }
  assert.equal(combinations, 1440);
});

test('high-DPI small screens shrink both axes and fractional work areas round inward', () => {
  assert.deepEqual(petSize(2, {scaleFactor: 2, workArea: {x: 0, y: 0, width: 640, height: 312}}), {width: 288, height: 312});
  assert.deepEqual(petSize(2, {scaleFactor: 2, workArea: {x: 0, y: 0, width: 683, height: 336}}), {width: 310, height: 336});
  const display = {id: 9, workArea: {x: -100.25, y: 20.25, width: 100.5, height: 110.5}};
  const size = petSize(2, display);
  contained({...clampPosition({x: 100, y: 200}, size, [display]), ...size}, display.workArea, 'fractional work area');
  assert.ok(Math.abs(size.width * 13 - size.height * 12) <= 12.5);
  assert.deepEqual(fitSizeToArea({width: 640, height: 80}, {x: 0, y: 0, width: 320, height: 320}), {width: 320, height: 40});
  assert.deepEqual(fitSizeToArea({width: 80, height: 640}, {x: 0, y: 0, width: 320, height: 320}), {width: 40, height: 320});
});

test('all 126 persisted scale increments use the same temporary dimensions for free and docked pets', () => {
  const display = {id: 1, scaleFactor: 2, workArea: {x: -800, y: -20, width: 640, height: 312}};
  for (let percent = 75; percent <= 200; percent += 1) {
    const size = petSize(percent / 100, display);
    const layout = dockBounds({displayId: 1, edge: 'right', ratio: 0.5}, petSize(percent / 100), [display]);
    assert.deepEqual({width: layout.expanded.width, height: layout.expanded.height}, size);
    // Requested dimensions and fitted dimensions each incur <= 0.5 DIP rounding.
    assert.ok(Math.abs(size.width * 13 - size.height * 12) <= 25);
    contained(layout.expanded, display.workArea, `${percent}%`);
  }
});
