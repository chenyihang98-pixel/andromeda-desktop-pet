'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DOCK_THRESHOLD, HIDE_DELAY, dockAt, dockBounds, fitDockBounds, hitTest, findDisplay } = require('../src/docking.cjs');

const primary = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const left = { id: 2, scaleFactor: 2, workArea: { x: -1280, y: -200, width: 1280, height: 984 } };
const right = { id: 3, scaleFactor: 1.5, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };
const size = { width: 240, height: 260 };
const at = (x, y, dimensions = size) => ({ x, y, ...dimensions });
const dock = (edge, ratio = 0.25, displayId = 1) => ({ displayId, edge, ratio });

function assertContained(bounds, area) {
  for (const value of Object.values(bounds)) assert.ok(Number.isInteger(value));
  assert.ok(bounds.width > 0 && bounds.height > 0);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}

test('dock threshold and delayed-hide duration are explicit constants', () => {
  assert.equal(DOCK_THRESHOLD, 18);
  assert.equal(HIDE_DELAY, 700);
});

test('all four edges include the exact 18-DIP threshold', () => {
  assert.deepEqual(dockAt(at(18, 195), [primary]), dock('left'));
  assert.deepEqual(dockAt(at(1662, 195), [primary]), dock('right'));
  assert.deepEqual(dockAt(at(420, 18), [primary]), dock('top'));
  assert.deepEqual(dockAt(at(420, 762), [primary]), dock('bottom'));
});

test('points beyond the threshold and the monitor interior do not dock', () => {
  for (const bounds of [at(18.001, 195), at(1661.999, 195), at(420, 18.001), at(420, 761.999), at(840, 390)]) {
    assert.equal(dockAt(bounds, [primary]), null);
  }
});

test('overshot edges dock and clamp the along-edge position', () => {
  assert.deepEqual(dockAt(at(-90, 195), [primary]), dock('left'));
  assert.deepEqual(dockAt(at(1770, 195), [primary]), dock('right'));
  assert.deepEqual(dockAt(at(420, -90), [primary]), dock('top'));
  assert.deepEqual(dockAt(at(420, 870), [primary]), dock('bottom'));
  assert.deepEqual(dockAt(at(-10, -80), [primary]), dock('left', 0));
  assert.deepEqual(dockAt(at(-10, 1000), [primary]), dock('left', 1));
});

test('corner ties are deterministic, with the closest edge winning first', () => {
  assert.deepEqual(dockAt(at(0, 0), [primary]), dock('left', 0));
  assert.deepEqual(dockAt(at(1680, 0), [primary]), dock('right', 0));
  assert.deepEqual(dockAt(at(0, 780), [primary]), dock('left', 1));
  assert.deepEqual(dockAt(at(1680, 780), [primary]), dock('right', 1));
  assert.equal(dockAt(at(12, 3), [primary]).edge, 'top');
  assert.equal(dockAt(at(1677, 768), [primary]).edge, 'right');
  assert.equal(dockAt(at(-40, 7), [primary]).edge, 'top');
});

test('expanded and collapsed bounds are correct on every edge', () => {
  const cases = [
    ['left', at(0, 195), at(0, 293, { width: 14, height: 64 })],
    ['right', at(1680, 195), at(1906, 293, { width: 14, height: 64 })],
    ['top', at(420, 0), at(508, 0, { width: 64, height: 14 })],
    ['bottom', at(420, 780), at(508, 1026, { width: 64, height: 14 })],
  ];
  for (const [edge, expanded, collapsed] of cases) {
    assert.deepEqual(dockBounds(dock(edge), size, [primary]), { expanded, collapsed });
  }
});

test('work area offsets and negative origins are respected', () => {
  const release = at(-1262, -19);
  const descriptor = dockAt(release, [primary, left]);
  assert.deepEqual(descriptor, dock('left', 0.25, 2));
  assert.deepEqual(dockBounds(descriptor, size, [primary, left]), {
    expanded: at(-1280, -19),
    collapsed: at(-1280, 79, { width: 14, height: 64 }),
  });
  const offset = { id: 9, workArea: { x: 80, y: -900, width: 1200, height: 800 } };
  assert.deepEqual(dockAt(at(320, -882), [offset]), dock('top', 0.25, 9));
  assert.deepEqual(dockBounds(dock('bottom', 1, 9), size, [offset]).expanded, at(1040, -360));
});

test('mixed-DPI displays are already in DIPs and are never rescaled', () => {
  const descriptor = dockAt(at(2942, 191), [primary, left, right]);
  assert.deepEqual(descriptor, dock('right', 0.25, 3));
  const result = dockBounds(descriptor, size, [right]);
  assert.deepEqual(result.expanded, at(2960, 191));
  assert.deepEqual(result.collapsed, at(3186, 289, { width: 14, height: 64 }));
  for (const scaleFactor of [0.5, 1, 1.25, 1.5, 2, 4, Infinity, '2']) {
    const scaled = { ...right, scaleFactor };
    assert.deepEqual(dockAt(at(2942, 191), [scaled]), descriptor);
    assert.deepEqual(dockBounds(descriptor, size, [scaled]), result);
  }
});

test('a cursor in the secondary work area takes priority over body overlap', () => {
  const bounds = at(1740, 191);
  assert.equal(findDisplay(bounds, [primary, right]), primary);
  assert.equal(findDisplay(bounds, [primary, right], { x: 1940, y: 200 }), right);
  assert.deepEqual(dockAt(bounds, [primary, right], { x: 1940, y: 200 }), dock('left', 0.25, 3));
});

test('shared display boundaries use half-open cursor containment', () => {
  const bounds = at(1780, 200);
  assert.equal(findDisplay(bounds, [primary, right], { x: 1919, y: 300 }), primary);
  assert.equal(findDisplay(bounds, [primary, right], { x: 1920, y: 300 }), right);
  assert.equal(findDisplay(bounds, [right, primary], { x: 1920, y: 300 }), right);
});

test('crossing into a secondary monitor does not cling to the primary edge', () => {
  assert.equal(dockAt(at(2200, 200), [primary, right], { x: 2300, y: 300 }), null);
  const bounds = Object.freeze(at(1800, 200));
  const displays = Object.freeze([primary, right]);
  dockAt(bounds, displays, { x: 1940, y: 300 });
  assert.deepEqual(bounds, at(1800, 200));
});

test('without a contained cursor the greatest overlapping work area wins', () => {
  assert.equal(findDisplay(at(-100, 100), [primary, left]), primary);
  assert.equal(findDisplay(at(-200, 100), [primary, left]), left);
  assert.equal(findDisplay(at(-200, 100), [primary, left], { x: 10000, y: 10000 }), left);
  assert.equal(findDisplay(at(-200, 100), [primary, left], { x: NaN, y: 0 }), left);
});

test('monitor gaps use the nearest fully visible position and stable input-order ties', () => {
  const a = { id: 'a', workArea: { x: 0, y: 0, width: 100, height: 100 } };
  const b = { id: 'b', workArea: { x: 300, y: 0, width: 100, height: 100 } };
  assert.equal(findDisplay(at(180, 40, { width: 20, height: 20 }), [a, b]), a);
  assert.equal(findDisplay(at(200, 40, { width: 20, height: 20 }), [a, b]), b);
  assert.equal(findDisplay(at(190, 40, { width: 20, height: 20 }), [a, b]), a);
  assert.equal(findDisplay(at(190, 40, { width: 20, height: 20 }), [b, a]), b);
});

test('small work areas shrink both windows without negative sizes or overflow', () => {
  for (const area of [
    { x: -50, y: 12, width: 8, height: 6 },
    { x: 0, y: -2, width: 1, height: 1 },
    { x: 100, y: 200, width: 40, height: 80 },
  ]) {
    const display = { id: 'tiny', workArea: area };
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      for (const ratio of [0, 0.25, 0.5, 1]) {
        const result = dockBounds(dock(edge, ratio, 'tiny'), size, [display]);
        assertContained(result.expanded, area);
        assertContained(result.collapsed, area);
      }
    }
    const descriptor = dockAt(at(area.x, area.y), [display]);
    assert.deepEqual(descriptor, dock('left', 0.5, 'tiny'));
  }
});

test('fractional work areas round bounds inward, with integral output', () => {
  const display = { id: 'fractional', workArea: { x: -99.7, y: 12.2, width: 701.2, height: 603.4 } };
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const result = dockBounds(dock(edge, 0.333, display.id), { width: 143.6, height: 155.8 }, [display]);
    assertContained(result.expanded, display.workArea);
    assertContained(result.collapsed, display.workArea);
  }
});

test('changing pet scale preserves the saved travel ratio', () => {
  const descriptor = dockAt(at(18, 195), [primary]);
  for (const dimensions of [{ width: 144, height: 156 }, size, { width: 384, height: 416 }]) {
    const result = dockBounds(descriptor, dimensions, [primary]);
    assert.equal(result.expanded.x, 0);
    assert.equal(result.expanded.y, Math.round((1040 - dimensions.height) * 0.25));
    assert.deepEqual(dockAt(result.expanded, [primary]), descriptor);
    assert.equal(result.collapsed.width, 14);
    assert.equal(result.collapsed.height, 64);
  }
});

test('changed work areas retain the dock descriptor and produce contained bounds', () => {
  const descriptor = dock('bottom', 0.63);
  const changed = { id: 1, workArea: { x: -1600, y: 80, width: 1600, height: 850 } };
  const result = dockBounds(descriptor, size, [changed]);
  assert.equal(result.expanded.x, -1600 + Math.round((1600 - 240) * 0.63));
  assert.equal(result.expanded.y, 670);
  assertContained(result.expanded, changed.workArea);
  assertContained(result.collapsed, changed.workArea);
  assert.deepEqual(descriptor, dock('bottom', 0.63));
});

test('removed monitors and mismatched ID types return null rather than relocating a dock', () => {
  assert.equal(dockBounds(dock('left', 0.5, 2), size, [primary]), null);
  assert.equal(dockBounds(dock('left', 0.5, '1'), size, [primary]), null);
  assert.equal(dockBounds(dock('left'), size, []), null);
});

test('hit testing is half-open, supports an explicit margin and rejects invalid data', () => {
  const bounds = { x: -50, y: 10, width: 14, height: 64 };
  assert.equal(hitTest({ x: -50, y: 10 }, bounds), true);
  assert.equal(hitTest({ x: -37, y: 73 }, bounds), true);
  assert.equal(hitTest({ x: -36, y: 20 }, bounds), false);
  assert.equal(hitTest({ x: -40, y: 74 }, bounds), false);
  assert.equal(hitTest({ x: -51, y: 9 }, bounds, 1), true);
  assert.equal(hitTest({ x: -35, y: 20 }, bounds, 1), false);
  for (const margin of [-1, NaN, Infinity, '1', 1e20]) assert.equal(hitTest({ x: -40, y: 20 }, bounds, margin), false);
  assert.equal(hitTest(null, bounds), false);
  assert.equal(hitTest({ x: 0, y: 0 }, null), false);
});

test('malformed and extreme bounds never produce docks or displays', () => {
  const invalid = [null, [], {}, true, 4, 'bounds', { x: 0, y: 0 },
    at(NaN, 0), at(Infinity, 0), at('0', 0), at(1e20, 0), at(0, -1e20),
    at(0, 0, { width: 0, height: 20 }), at(0, 0, { width: -1, height: 20 }),
    at(0, 0, { width: 20, height: Infinity }), at(0, 0, { width: 1e20, height: 20 }),
    Object.create(at(0, 0)), new Date(), JSON.parse('{"__proto__":{"x":0,"y":0,"width":240,"height":260}}')];
  for (const bounds of invalid) {
    assert.equal(dockAt(bounds, [primary]), null);
    assert.equal(findDisplay(bounds, [primary]), null);
    assert.equal(hitTest({ x: 0, y: 0 }, bounds), false);
  }
});

test('malformed display entries are skipped and empty catalogs fail safely', () => {
  const invalid = [null, {}, { id: 1 }, { workArea: primary.workArea },
    { id: NaN, workArea: primary.workArea }, { id: {}, workArea: primary.workArea },
    { id: '', workArea: primary.workArea }, { id: 1, workArea: at(0, 0, { width: -1, height: 20 }) },
    { id: 1, workArea: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }];
  for (const displays of [null, undefined, {}, 4, ...invalid.map((item) => [item]), []]) {
    assert.equal(dockAt(at(0, 195), displays), null);
    assert.equal(findDisplay(at(0, 195), displays), null);
    assert.equal(dockBounds(dock('left'), size, displays), null);
  }
  assert.equal(findDisplay(at(0, 195), [...invalid, primary]), primary);
});

test('invalid dock descriptors and sizes cannot reach native window bounds', () => {
  for (const descriptor of [null, [], {}, { ...dock('left'), edge: '__proto__' },
    { ...dock('left'), ratio: NaN }, { ...dock('left'), ratio: Infinity },
    { ...dock('left'), ratio: '0.25' }, { ...dock('left'), ratio: -0.01 },
    { ...dock('left'), ratio: 1.01 }, Object.create(dock('left'))]) {
    assert.equal(dockBounds(descriptor, size, [primary]), null);
  }
  for (const dimensions of [null, [], {}, { width: 0, height: 20 }, { width: -20, height: 20 },
    { width: '240', height: 260 }, { width: NaN, height: 20 }, { width: 20, height: 1e20 }]) {
    assert.equal(dockBounds(dock('left'), dimensions, [primary]), null);
  }
});

test('plain null-prototype records are supported and getters are never evaluated', () => {
  const bounds = Object.assign(Object.create(null), at(0, 195));
  assert.deepEqual(dockAt(bounds, [primary]), dock('left'));
  let reads = 0;
  const accessor = Object.defineProperty(at(0, 195), 'x', { get() { reads += 1; throw new Error('unsafe getter'); } });
  assert.equal(dockAt(accessor, [primary]), null);
  assert.equal(findDisplay(accessor, [primary]), null);
  const display = Object.defineProperty({ id: 1 }, 'workArea', { get() { reads += 1; throw new Error('unsafe getter'); } });
  assert.equal(dockBounds(dock('left'), size, [display]), null);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(dockAt(revoked.proxy, [primary]), null);
  assert.equal(reads, 0);
});

test('geometry calls do not mutate frozen input records', () => {
  const display = Object.freeze({ id: 1, workArea: Object.freeze({ ...primary.workArea }) });
  const descriptor = Object.freeze(dock('left'));
  const dimensions = Object.freeze({ ...size });
  const bounds = Object.freeze(at(0, 195));
  const displays = Object.freeze([display]);
  assert.deepEqual(dockAt(bounds, displays), descriptor);
  assert.equal(findDisplay(bounds, displays), display);
  assert.deepEqual(dockBounds(descriptor, dimensions, displays).expanded, bounds);
});

test('deterministic geometry sweep keeps every handle and expanded window in its work area', () => {
  for (const display of [primary, left, right]) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      for (let step = 0; step <= 100; step += 1) {
        const ratio = step / 100;
        const dimensions = { width: 20 + step * 4, height: 30 + step * 5 };
        const result = dockBounds(dock(edge, ratio, display.id), dimensions, [display]);
        assertContained(result.expanded, display.workArea);
        assertContained(result.collapsed, display.workArea);
        if (edge === 'left') assert.equal(result.expanded.x, display.workArea.x);
        if (edge === 'right') assert.equal(result.expanded.x + result.expanded.width, display.workArea.x + display.workArea.width);
        if (edge === 'top') assert.equal(result.expanded.y, display.workArea.y);
        if (edge === 'bottom') assert.equal(result.expanded.y + result.expanded.height, display.workArea.y + display.workArea.height);
      }
    }
  }
});

test('measured native minimum sizes are fitted to the original display and edge', () => {
  for (const display of [primary, left, right]) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      for (const ratio of [0, 0.5, 1]) {
        const descriptor = dock(edge, ratio, display.id);
        const requested = dockBounds(descriptor, size, [display]).collapsed;
        const measured = {...requested, width: Math.max(30, requested.width), height: Math.max(36, requested.height)};
        const fitted = fitDockBounds(descriptor, requested, measured, [primary, left, right]);
        assertContained(fitted, display.workArea);
        assert.equal(fitted.width, measured.width);
        assert.equal(fitted.height, measured.height);
        if (edge === 'left') assert.equal(fitted.x, display.workArea.x);
        if (edge === 'right') assert.equal(fitted.x + fitted.width, display.workArea.x + display.workArea.width);
        if (edge === 'top') assert.equal(fitted.y, display.workArea.y);
        if (edge === 'bottom') assert.equal(fitted.y + fitted.height, display.workArea.y + display.workArea.height);
      }
    }
  }
});

test('native fitting rejects removed displays and sizes that cannot fit without moving displays', () => {
  const descriptor = dock('right', 0.5, left.id);
  const requested = dockBounds(descriptor, size, [left]).collapsed;
  assert.equal(fitDockBounds(descriptor, requested, requested, [primary]), null);
  assert.equal(fitDockBounds(descriptor, requested, {...requested, width: left.workArea.width + 1}, [left, primary]), null);
  assert.equal(fitDockBounds(descriptor, requested, {...requested, height: left.workArea.height + 1}, [left, primary]), null);
  assert.equal(fitDockBounds(descriptor, requested, {...requested, width: NaN}, [left]), null);
});
