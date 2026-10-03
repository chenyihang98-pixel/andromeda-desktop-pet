'use strict';

// Electron screen coordinates, work areas and BrowserWindow bounds are already
// device-independent pixels. Never multiply these values by display.scaleFactor.
const DOCK_THRESHOLD = 18;
const HIDE_DELAY = 700;
const MAX_COORDINATE = 10_000_000;
const EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);

// Accept only plain data records. In particular, don't execute accessors on
// values that may have originated in a saved record or an IPC message.
function fields(value, names) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const result = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function coordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function point(value) {
  const clean = fields(value, ['x', 'y']);
  return clean && coordinate(clean.x) && coordinate(clean.y) ? clean : null;
}

function rectangle(value) {
  const clean = fields(value, ['x', 'y', 'width', 'height']);
  if (!clean || !coordinate(clean.x) || !coordinate(clean.y)
    || !coordinate(clean.width) || clean.width <= 0
    || !coordinate(clean.height) || clean.height <= 0
    || !coordinate(clean.x + clean.width) || !coordinate(clean.y + clean.height)) return null;
  return clean;
}

function displayId(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

function displaysWithAreas(displays) {
  if (!Array.isArray(displays)) return [];
  const result = [];
  for (const display of displays) {
    const data = fields(display, ['id', 'workArea']);
    if (!data || !displayId(data.id)) continue;
    const raw = rectangle(data.workArea);
    if (!raw) continue;
    // BrowserWindow requires integral bounds. Round inward, so the returned
    // window is still contained even if a synthetic work area is fractional.
    const x = Math.ceil(raw.x);
    const y = Math.ceil(raw.y);
    const area = { x, y, width: Math.floor(raw.x + raw.width) - x, height: Math.floor(raw.y + raw.height) - y };
    if (area.width < 1 || area.height < 1) continue;
    result.push({ display, id: data.id, area, raw });
  }
  return result;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function contained(pointValue, bounds, margin = 0) {
  return pointValue.x >= bounds.x - margin && pointValue.y >= bounds.y - margin
    && pointValue.x < bounds.x + bounds.width + margin
    && pointValue.y < bounds.y + bounds.height + margin;
}

// Half-open rectangles make a cursor on an adjacent-monitor boundary belong
// to exactly one work area. The margin expands all four sides equally.
function hitTest(pointValue, bounds, margin = 0) {
  const cleanPoint = point(pointValue);
  const cleanBounds = rectangle(bounds);
  return Boolean(cleanPoint && cleanBounds && coordinate(margin) && margin >= 0
    && contained(cleanPoint, cleanBounds, margin));
}

function selectDisplay(bounds, displays, cursor) {
  const candidates = displaysWithAreas(displays);
  const cleanCursor = point(cursor);
  if (cleanCursor) {
    const underCursor = candidates.find((candidate) => contained(cleanCursor, candidate.raw));
    if (underCursor) return underCursor;
  }

  let best = null;
  let bestOverlap = -1;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const area = candidate.area;
    const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
    const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    const overlap = width * height;
    const x = clamp(bounds.x, area.x, area.x + Math.max(0, area.width - bounds.width));
    const y = clamp(bounds.y, area.y, area.y + Math.max(0, area.height - bounds.height));
    const distance = (x - bounds.x) ** 2 + (y - bounds.y) ** 2;
    // Input order breaks exact ties, matching settings.clampPosition.
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      best = candidate;
      bestOverlap = overlap;
      bestDistance = distance;
    }
  }
  return best;
}

// Returns the original display, not a copy, or null for unusable inputs.
function findDisplay(bounds, displays, cursor) {
  const cleanBounds = rectangle(bounds);
  return cleanBounds ? selectDisplay(cleanBounds, displays, cursor)?.display ?? null : null;
}

// This function has no drag side effects. Call it only when a drag is released,
// allowing a window to cross a shared monitor edge freely while being dragged.
function dockAt(bounds, displays, cursor) {
  const cleanBounds = rectangle(bounds);
  if (!cleanBounds) return null;
  const candidate = selectDisplay(cleanBounds, displays, cursor);
  if (!candidate) return null;
  const area = candidate.area;
  const distances = [
    cleanBounds.x - area.x,
    area.x + area.width - cleanBounds.x - cleanBounds.width,
    cleanBounds.y - area.y,
    area.y + area.height - cleanBounds.y - cleanBounds.height,
  ];
  let edge = null;
  let nearest = Infinity;
  for (let index = 0; index < EDGES.length; index += 1) {
    const distance = distances[index];
    // Negative distances are an overshoot. Rank by distance from the actual
    // edge, not by penetration depth or an already-clamped window position.
    if (distance <= DOCK_THRESHOLD && Math.abs(distance) < nearest) {
      edge = EDGES[index];
      nearest = Math.abs(distance);
    }
  }
  if (!edge) return null;
  const vertical = edge === 'left' || edge === 'right';
  const length = vertical ? area.height : area.width;
  const size = Math.min(vertical ? cleanBounds.height : cleanBounds.width, length);
  const travel = length - size;
  const origin = vertical ? area.y : area.x;
  const position = vertical ? cleanBounds.y : cleanBounds.x;
  const ratio = travel > 0 ? clamp((position - origin) / travel, 0, 1) : 0.5;
  return { displayId: candidate.id, edge, ratio };
}

function anchoredBounds(area, size, edge, ratio) {
  const width = Math.min(area.width, Math.max(1, Math.round(size.width)));
  const height = Math.min(area.height, Math.max(1, Math.round(size.height)));
  let x = area.x + Math.round((area.width - width) * ratio);
  let y = area.y + Math.round((area.height - height) * ratio);
  if (edge === 'left') x = area.x;
  if (edge === 'right') x = area.x + area.width - width;
  if (edge === 'top') y = area.y;
  if (edge === 'bottom') y = area.y + area.height - height;
  return { x, y, width, height };
}

function dockBounds(dock, size, displays) {
  const cleanDock = fields(dock, ['displayId', 'edge', 'ratio']);
  const cleanSize = fields(size, ['width', 'height']);
  if (!cleanDock || !displayId(cleanDock.displayId) || !EDGES.includes(cleanDock.edge)
    || !Number.isFinite(cleanDock.ratio) || cleanDock.ratio < 0 || cleanDock.ratio > 1
    || !cleanSize || !coordinate(cleanSize.width) || cleanSize.width <= 0
    || !coordinate(cleanSize.height) || cleanSize.height <= 0) return null;
  const candidate = displaysWithAreas(displays).find((display) => display.id === cleanDock.displayId);
  if (!candidate) return null; // A removed display must be handled by the caller.
  const { area } = candidate;
  const expanded = anchoredBounds(area, cleanSize, cleanDock.edge, cleanDock.ratio);
  const vertical = cleanDock.edge === 'left' || cleanDock.edge === 'right';
  const collapsed = anchoredBounds(area, vertical ? { width: 14, height: 64 } : { width: 64, height: 14 }, cleanDock.edge, cleanDock.ratio);
  // Keep the handle centered beside the expanded pet, clamped at corners.
  if (vertical) collapsed.y = clamp(Math.round(expanded.y + (expanded.height - collapsed.height) / 2), area.y, area.y + area.height - collapsed.height);
  else collapsed.x = clamp(Math.round(expanded.x + (expanded.width - collapsed.width) / 2), area.x, area.x + area.width - collapsed.width);
  return { expanded, collapsed };
}

module.exports = { DOCK_THRESHOLD, HIDE_DELAY, dockAt, dockBounds, hitTest, findDisplay };
