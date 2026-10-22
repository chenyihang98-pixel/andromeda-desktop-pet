import {validateCharacterPack, resolveAction} from './shared/character.mjs';
import {cropRect, frameAt} from './animation.mjs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** A canvas-only adapter. The caller supplies checked local artwork and owns the
 * classic pet's gestures, menus, rhythm and visibility. No native API or network. */
export function createCustomCharacter({canvas, pack, imageDataURL, reducedMotion = false, showAnchors = false}) {
  const character = validateCharacterPack(pack);
  if (typeof reducedMotion !== 'boolean' || typeof showAnchors !== 'boolean') throw new TypeError('角色显示选项无效。');
  if (typeof imageDataURL !== 'string' || imageDataURL.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 32
    || !/^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataURL)
    || imageDataURL.endsWith(',')) throw new TypeError('角色图片必须是最多 8 MiB 的本地 PNG/WebP。');
  const encoded = imageDataURL.slice(imageDataURL.indexOf(',') + 1);
  if (encoded.length % 4 || encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) > MAX_IMAGE_BYTES) throw new TypeError('角色图片格式或大小无效。');
  const doc = canvas?.ownerDocument, win = doc?.defaultView;
  if (!doc || !win || typeof win.Image !== 'function' || typeof canvas.getContext !== 'function') throw new TypeError('角色需要可用的画布。');
  const context = canvas.getContext('2d');
  const mask = doc.createElement('canvas'), maskContext = mask.getContext('2d', {willReadFrequently: true});
  if (!context || !maskContext) throw new TypeError('当前环境无法绘制角色。');
  const validCanvas = () => Number.isInteger(canvas.width) && Number.isInteger(canvas.height)
    && canvas.width > 0 && canvas.height > 0 && canvas.width <= 4096 && canvas.height <= 4096;
  if (!validCanvas()) throw new TypeError('显示画布尺寸无效。');
  const motionQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => reducedMotion || Boolean(motionQuery?.matches);
  const clock = () => win.performance.now();
  let image = new win.Image(), loaded = false, destroyed = false, timer = null, generation = 0;
  let pending = {kind: 'neutral'}, playing = false, current = null, startedAt = 0;
  let settleReady;
  const ready = new Promise((resolve, reject) => {settleReady = {resolve, reject};});
  // A caller can await ready; early destruction also settles it without an orphan.
  ready.catch(() => {});

  function layout() {
    const scale = Math.min(canvas.width / character.atlas.cellWidth, canvas.height / character.atlas.cellHeight);
    const width = character.atlas.cellWidth * scale, height = character.atlas.cellHeight * scale;
    return {x: (canvas.width - width) / 2, y: canvas.height - height, width, height};
  }
  function anchors() {
    const area = layout();
    return Object.fromEntries(Object.entries(character.anchors).map(([name, point]) => [name, {
      x: area.x + point.x * area.width, y: area.y + point.y * area.height,
    }]));
  }
  function paint(row, column) {
    if (!loaded || destroyed || !validCanvas()) return false;
    if (mask.width !== canvas.width || mask.height !== canvas.height) {mask.width = canvas.width; mask.height = canvas.height;}
    const area = layout();
    maskContext.clearRect(0, 0, mask.width, mask.height);
    maskContext.drawImage(image, ...cropRect(character.atlas, row, column), area.x, area.y, area.width, area.height);
    context.save();context.setTransform(1, 0, 0, 1, 0, 0);context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(mask, 0, 0);
    if (showAnchors) {
      context.lineWidth = 1;context.font = '10px sans-serif';context.fillStyle = '#db2777';context.strokeStyle = '#db2777';
      for (const [name, point] of Object.entries(anchors())) {
        context.beginPath();context.arc(point.x, point.y, 3, 0, Math.PI * 2);context.stroke();
        context.fillText(name, Math.min(canvas.width - 46, Math.max(0, point.x + 5)), Math.max(10, point.y - 5));
      }
    }
    context.restore();current = {row, column};return true;
  }
  function stop() {
    generation++;win.clearTimeout(timer);timer = null;playing = false;pending = null;
  }
  function neutral() {
    if (destroyed) return false;
    stop();pending = {kind: 'neutral'};
    return paint(character.neutral.row, character.neutral.column);
  }
  function animate(clip, token) {
    if (destroyed || token !== generation || !playing) return;
    if (doc.hidden || reduced()) {playing = false;paint(clip.row, 0);return;}
    const frame = frameAt(clip, clock() - startedAt);
    if (!frame) {neutral();return;}
    paint(frame.row, frame.column);
    timer = win.setTimeout(() => animate(clip, token), Math.max(1, Math.ceil(frame.remainingMs)));
  }
  function draw(semantic) {
    if (destroyed) return null;
    const clip = resolveAction(character, semantic, {reducedMotion: reduced()});
    stop();pending = {kind: 'semantic', semantic};
    if (loaded) {
      if (clip.static || doc.hidden) paint(clip.row, clip.column);
      else {playing = true;startedAt = clock();animate(clip, generation);}
    }
    return clip;
  }
  function gaze(dx, dy) {
    if (destroyed || playing || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (reduced() || !character.lookDirections || Math.hypot(dx, dy) < 24) return neutral();
    const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const directions = character.lookDirections;
    let index = 0, distance = 361;
    for (let candidate = 0; candidate < directions.degreesClockwise.length; candidate++) {
      const difference = Math.abs(directions.degreesClockwise[candidate] - degrees);
      const circular = Math.min(difference, 360 - difference);
      if (circular < distance) {index = candidate;distance = circular;}
    }
    stop();pending = {kind: 'gaze', dx, dy};
    return paint(directions.rows[Math.floor(index / character.atlas.columns)], index % character.atlas.columns);
  }
  function setReducedMotion(value) {
    if (typeof value !== 'boolean') throw new TypeError('减少动画选项无效。');
    if (destroyed) return;
    reducedMotion = value;
    // A preference change never resumes an action previously stopped by the user.
    if (reduced()) {const semantic = pending?.kind === 'semantic' ? pending.semantic : null;semantic ? draw(semantic) : neutral();}
  }
  function hitTest(x, y) {
    if (!loaded || destroyed || !current || !validCanvas() || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    // Canvas pixels, not client coordinates. The caller applies its CSS/DPR scale.
    try {return maskContext.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 16;} catch {return false;}
  }
  const onVisibility = () => {if (doc.hidden) neutral();};
  const onMotion = () => {if (reduced()) setReducedMotion(reducedMotion);};
  doc.addEventListener('visibilitychange', onVisibility);
  motionQuery?.addEventListener?.('change', onMotion);
  image.onload = () => {
    if (destroyed) return;
    if (image.naturalWidth !== character.atlas.width || image.naturalHeight !== character.atlas.height) {
      image.onload = null;image.onerror = null;settleReady.reject(new Error('角色图片解码尺寸与角色包不一致。'));return;
    }
    loaded = true;image.onload = null;image.onerror = null;
    const request = pending;
    if (request?.kind === 'semantic') draw(request.semantic);
    else if (request?.kind === 'gaze') gaze(request.dx, request.dy);
    else if (request?.kind === 'neutral') neutral();
    settleReady.resolve(true);
  };
  image.onerror = () => {
    if (destroyed) return;
    image.onload = null;image.onerror = null;settleReady.reject(new Error('角色 PNG/WebP 图片无法解码。'));
  };
  image.src = imageDataURL;
  function destroy() {
    if (destroyed) return;
    destroyed = true;stop();loaded = false;current = null;
    doc.removeEventListener('visibilitychange', onVisibility);motionQuery?.removeEventListener?.('change', onMotion);
    image.onload = null;image.onerror = null;image.removeAttribute?.('src');image = null;
    mask.width = 0;mask.height = 0;
    context.save();context.setTransform(1, 0, 0, 1, 0, 0);context.clearRect(0, 0, canvas.width, canvas.height);context.restore();
    settleReady.resolve(false);
  }
  return Object.freeze({ready, draw, neutral, gaze, setReducedMotion, anchors, stop, hitTest, destroy});
}
