/** Pure sprite selection functions. No timers or native APIs. */
export const ACTIONS = Object.freeze({wave: 'waving', jump: 'jumping', wait: 'waiting', review: 'review'});
export function frameAt(animation, elapsedMs, multiplier = 1) {
  if (!animation || !Array.isArray(animation.durationsMs) || !Number.isFinite(elapsedMs)) return null;
  let remaining = Math.max(0, elapsedMs);
  for (let column = 0; column < animation.durationsMs.length; column++) {
    const duration = animation.durationsMs[column] * multiplier;
    if (remaining < duration) return {row: animation.row, column, remainingMs: duration - remaining};
    remaining -= duration;
  }
  return null;
}
export function neutralDelay(motion, random = Math.random) {
  if (motion === 'still') return null;
  const [min, max] = motion === 'lively' ? [12000, 20000] : [45000, 90000];
  const fraction = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(min + fraction * (max - min));
}
export function gazeCell(dx, dy, deadzone = 24) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < deadzone) return {row: 0, column: 0};
  const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const index = Math.round(degrees / 22.5) % 16;
  return {row: 9 + Math.floor(index / 8), column: index % 8};
}
export function cropRect(atlas, row, column) {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0 || row >= atlas.rows || column >= atlas.columns) throw new RangeError('Invalid sprite cell');
  return [column * atlas.cellWidth, row * atlas.cellHeight, atlas.cellWidth, atlas.cellHeight];
}

/** Preserve the source aspect ratio, centered horizontally and resting on the
 * target's bottom edge. Fractional sprite cells are supported without stretching. */
export function containRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid image or target dimensions');
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return {x: (targetWidth - width) / 2, y: targetHeight - height, width, height};
}
