/** Aggregate progress for one explicitly opted-in article/project container. */
export function createReadingProgress({minimumVisibleMs = 12000} = {}) {
  const minimum = Math.max(1000, Math.min(60000, Number(minimumVisibleMs) || 12000));
  let visibleMs = 0, progress = 0, lastAt = null, wasActive = false;
  return {
    update({now, top, height, viewportHeight, enabled, visible}) {
      const active = !!enabled && !!visible && height > 0 && top < viewportHeight && top + height > 0;
      if (active && wasActive && lastAt !== null) visibleMs += Math.max(0, Math.min(1500, now - lastAt));
      if (active) progress = Math.max(progress, Math.max(0, Math.min(1, (viewportHeight - top) / height)));
      lastAt = now; wasActive = active;
      return {visibleMs, progress, timeReady: visibleMs >= minimum, eligible: visibleMs >= minimum && progress >= .85};
    },
  };
}
