/** Original transparent life poses. These are individual still poses, not animation frames. */
export const STUDIO_POSES = Object.freeze({idle: 0, greet: 1, happy: 2, think: 3, read: 4, question: 5, stretch: 6, sleep: 7, pet: 8, drag: 9, 'point-left': 10, 'point-right': 11, notify: 1});
export function studioCrop(semantic = 'idle', imageWidth = 1254, imageHeight = 1254) {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth < 4 || imageHeight < 3) throw new TypeError('静态姿态图尺寸无效');
  const index = Object.hasOwn(STUDIO_POSES, semantic) ? STUDIO_POSES[semantic] : 0;
  const width = imageWidth / 4, height = imageHeight / 3;
  return {index, rect: [(index % 4) * width, Math.floor(index / 4) * height, width, height], static: true};
}
