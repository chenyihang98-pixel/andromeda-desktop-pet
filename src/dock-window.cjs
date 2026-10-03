'use strict';

const { dockBounds, fitDockBounds } = require('./docking.cjs');
const sameBounds = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);

// The native geometry smoke probe uses this same boundary as the application.
// A null result means this display cannot safely contain the native window.
function applyDockWindowBounds(window, dock, size, displays) {
  const layout = dockBounds(dock, size, displays);
  if (!layout) return null;
  const requested = dock.collapsed ? layout.collapsed : layout.expanded;
  window.setBounds(requested);
  const measured = window.getBounds();
  const expected = fitDockBounds(dock, requested, measured, displays);
  if (!expected) return null;
  if (measured.x !== expected.x || measured.y !== expected.y) window.setPosition(expected.x, expected.y);
  const actual = window.getBounds();
  if (!sameBounds(actual, expected)) return null;
  return { requested, measured, expected, actual };
}

module.exports = { applyDockWindowBounds };
