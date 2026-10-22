import {validateCharacterPack, resolveAction, SEMANTIC_FALLBACKS} from './shared/character.mjs';

export const EDITOR_LIMITS = Object.freeze({jsonBytes: 65536, imageBytes: 8 * 1024 * 1024, pixels: 64 * 1024 * 1024});
const clone = value => JSON.parse(JSON.stringify(value));

export function parseCharacterJSON(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > EDITOR_LIMITS.jsonBytes) throw new TypeError('角色 JSON 不能超过 64 KiB。');
  return validateCharacterPack(JSON.parse(text));
}
export function setGroundAnchor(pack, x, y) {
  if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new TypeError('锚点坐标需要在 0–1 之间。');
  const next = validateCharacterPack(pack);
  next.anchors.ground = {x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000};
  return next;
}
export function previewFrame(pack, semantic, elapsedMs, reducedMotion = false) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new TypeError('播放时间无效。');
  const clip = resolveAction(pack, semantic, {reducedMotion});
  const total = clip.durationsMs.reduce((sum, duration) => sum + duration, 0);
  let time = elapsedMs % total, column = clip.column;
  if (!clip.static) for (let i = 0; i < clip.frameCount; i++) {
    if (time < clip.durationsMs[i]) {column = i; break;}
    time -= clip.durationsMs[i];
  }
  return {...clip, column, totalMs: total, remainingMs: clip.durationsMs[clip.static ? 0 : column] - time};
}
export function setAnimation(pack, {name, row, frameCount, durations}) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new TypeError('动作名只使用英文字母、数字、点、横线或下划线。');
  if (typeof durations !== 'string' || durations.length > 2000 || !durations.trim()) throw new TypeError('请填写每帧毫秒数。');
  let values = durations.trim().split(/[\s,，]+/).map(Number);
  if (values.length === 1 && Number.isInteger(frameCount) && frameCount >= 1 && frameCount <= 64) values = Array(frameCount).fill(values[0]);
  const next = validateCharacterPack(pack);
  Object.defineProperty(next.animations, name, {value: {row, frameCount, durationsMs: values}, enumerable: true, configurable: true});
  return validateCharacterPack(next);
}
export function setGrid(pack, columns, rows) {
  const next = validateCharacterPack(pack);
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > 64 || rows > 128
    || next.atlas.width % columns || next.atlas.height % rows) throw new TypeError('网格必须整除图片宽高；列为 1–64，行为 1–128。');
  next.atlas = {...next.atlas, columns, rows, cellWidth: next.atlas.width / columns, cellHeight: next.atlas.height / rows};
  return validateCharacterPack(next);
}

/** Inspect image headers before decoding. SVG, HTML and remote URLs are never imported. */
export function inspectImageBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > EDITOR_LIMITS.imageBytes) throw new TypeError('图片需要是最多 8 MiB 的 PNG 或 WebP。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  let width, height, mime;
  if ([137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value) && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
    let offset=8,hasData=false,ended=false;
    if(view.getUint32(8)!==13)throw new TypeError('PNG 图像头不完整。');
    while(offset+12<=bytes.length){
      const length=view.getUint32(offset),kind=ascii(offset+4,4),end=offset+12+length;
      if(end>bytes.length)throw new TypeError('PNG 文件不完整。');
      if(['acTL','fcTL','fdAT'].includes(kind))throw new TypeError('请导入静态图集，不接受动画 PNG。');
      if(kind==='IDAT'&&length>0)hasData=true;
      if(kind==='IEND'){if(length!==0||end!==bytes.length)throw new TypeError('PNG 文件末尾无效。');ended=true;break;}
      offset=end;
    }
    if(!ended||!hasData)throw new TypeError('PNG 缺少完整图像内容。');
  } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
    mime = 'image/webp';
    for (let start = 12; start + 8 <= bytes.length;) {
      const size = view.getUint32(start + 4, true), data = start + 8, kind = ascii(start, 4);
      if (data + size > bytes.length) throw new TypeError('WebP 文件不完整。');
      if (kind === 'VP8X' && size >= 10) {
        if (bytes[data] & 2) throw new TypeError('请导入静态图集，不接受动画 WebP。');
        width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16); break;
      }
      if (kind === 'VP8L' && size >= 5 && bytes[data] === 47) {
        const bits = view.getUint32(data + 1, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; break;
      }
      if (kind === 'VP8 ' && size >= 10 && bytes[data + 3] === 157 && bytes[data + 4] === 1 && bytes[data + 5] === 42) {
        width = view.getUint16(data + 6, true) & 0x3fff; height = view.getUint16(data + 8, true) & 0x3fff; break;
      }
      start = data + size + (size % 2);
    }
  }
  if (!mime || !width || !height || width > 16384 || height > 16384 || width * height > EDITOR_LIMITS.pixels) throw new TypeError('图片格式或尺寸无效；最大边长 16384，最多 6400 万像素。');
  return {width, height, mime};
}

/** Mount into an existing element. The caller owns its dialog and export destination. */
export function mountCharacterEditor({root, initialPack, onExport}) {
  if (!root?.ownerDocument || typeof root.replaceChildren !== 'function' || typeof onExport !== 'function') throw new TypeError('编辑器需要容器和导出处理器。');
  let pack = validateCharacterPack(initialPack);
  const doc = root.ownerDocument, win = doc.defaultView, controller = new win.AbortController();
  let image = null, imageDataURL, destroyed = false, timer, startedAt = 0, playing = false, frame = 0, generation = 0;
  let semantic = 'idle', reducedMotion = false;
  const el = (tag, text, attributes = {}) => {
    const node = doc.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const input = (label, type = 'text', attributes = {}) => {
    const node = el('input', '', {type, 'aria-label': label, ...attributes});
    const wrap = el('label', label + ' '); wrap.append(node); return {node, wrap};
  };
  const status = el('p', '选择动作查看；点击预览画面设置脚底锚点。', {role: 'status', 'aria-live': 'polite'});
  const report = (message, error = false) => {if (!destroyed) {status.textContent = message; status.dataset.error = String(error);}};
  const listen = (node, type, callback) => node.addEventListener(type, callback, {signal: controller.signal});
  const attempt = callback => async () => {try {await callback();} catch (error) {report(error?.message || '操作未完成。', true);}};
  const button = (label, callback) => {const node = el('button', label, {type: 'button'}); listen(node, 'click', attempt(callback)); return node;};
  const row = (...nodes) => {const node = el('div'); node.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0'; node.append(...nodes); return node;};
  const imageFile = input('导入图集', 'file', {accept: 'image/png,image/webp,.png,.webp'});
  const jsonFile = input('导入角色 JSON', 'file', {accept: 'application/json,.json'});
  const canvas = el('canvas', '', {'aria-label': '角色预览，点击设置脚底锚点', tabindex: '0'});
  canvas.style.cssText = 'display:block;max-width:100%;border:1px solid #64748b;border-radius:8px;touch-action:none;cursor:crosshair';
  const context = canvas.getContext('2d'); if (!context) throw new Error('当前环境无法显示画布。');
  const caption = el('p'), semantics = el('select', '', {'aria-label': '动作语义'}), clips = el('select', '', {'aria-label': '语义对应动画'});
  const columns = input('图集列数', 'number', {min: '1', max: '64'}), rows = input('图集行数', 'number', {min: '1', max: '128'});
  const clipName = input('动作名'), clipRow = input('动作所在行（从 0 开始）', 'number', {min: '0', max: '127'});
  const count = input('帧数', 'number', {min: '1', max: '64'}), durations = input('每帧毫秒（逗号分隔，单值重复）');
  const reduced = input('减少动画预览', 'checkbox'), anchorX = input('地面锚点 X', 'number', {min: '0', max: '1', step: '.01'}), anchorY = input('地面锚点 Y', 'number', {min: '0', max: '1', step: '.01'});
  const json = el('textarea', '', {'aria-label': '角色包 JSON', rows: '9', spellcheck: 'false'}); json.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace';
  const playButton = button('播放预览', () => {stop(); playing = true; startedAt = win.performance.now(); draw();});
  const exportButton = button('导出角色包与所选图集', async () => {
    const clean = parseCharacterJSON(json.value);
    if (!image || image.naturalWidth !== clean.atlas.width || image.naturalHeight !== clean.atlas.height || clean.atlas.image !== pack.atlas.image) throw new Error('请先应用 JSON 并导入与元数据一致的图集。');
    exportButton.disabled = true;
    try {const result = await onExport({pack: clean, ...(imageDataURL ? {imageDataURL} : {})}); if (result !== false) report('已交给宿主保存；请保留图片和元数据的相对路径。');}
    finally {if (!destroyed) exportButton.disabled = false;}
  });
  const content = el('section', '', {'aria-label': '可视角色包编辑器'});
  content.append(el('p', '图集只从你选择的 PNG/WebP 导入。JSON 里的路径不会自动下载图片或运行脚本。'), row(imageFile.wrap, jsonFile.wrap), status,
    row(columns.wrap, rows.wrap, button('应用网格', () => {pack = setGrid(pack, Number(columns.node.value), Number(rows.node.value));sync();report('网格已更新。动作行号从 0 开始。');})),
    row(el('span', '语义'), semantics, el('span', '对应动画'), clips, button('保存语义映射', () => {
      const next = clone(pack); next.actions[semantic] = clips.value; pack = validateCharacterPack(next); sync();report('语义映射已保存。');
    })), canvas, caption, row(playButton, button('停止预览', () => {stop();draw();}), reduced.wrap),
    row(anchorX.wrap, anchorY.wrap, button('应用地面锚点', () => {pack = setGroundAnchor(pack, Number(anchorX.node.value), Number(anchorY.node.value));sync();})),
    el('h3', '添加或调整动作'), row(clipName.wrap, clipRow.wrap, count.wrap), durations.wrap,
    row(button('保存动作', () => {pack = setAnimation(pack, {name: clipName.node.value.trim(), row: Number(clipRow.node.value), frameCount: Number(count.node.value), durations: durations.node.value});sync();report('动作已保存；可在上方选择语义并映射到它。');})),
    el('h3', '元数据与来源'), el('p', '可在 JSON 中编辑名字、来源、授权和更多锚点。导入后请核对动作及图片，不能只改文件扩展名。'), json,
    row(button('应用 JSON', () => applyJSON(json.value)), exportButton));
  root.replaceChildren(content);

  function stop() {playing = false; win.clearTimeout(timer); timer = null; startedAt = 0;}
  function draw() {
    win.clearTimeout(timer); timer = null; if (destroyed) return;
    const selected = previewFrame(pack, semantic, playing ? win.performance.now() - startedAt : 0, reducedMotion);
    frame = selected.column; canvas.dataset.frame = String(frame); canvas.dataset.playing = String(playing);
    const scale = Math.min(384 / pack.atlas.cellWidth, 416 / pack.atlas.cellHeight);
    const width = Math.max(1, Math.round(pack.atlas.cellWidth * scale)), height = Math.max(1, Math.round(pack.atlas.cellHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {canvas.width = width; canvas.height = height;}
    for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) {context.fillStyle = ((x + y) / 16) % 2 ? '#dce2eb' : '#ffffff';context.fillRect(x, y, 16, 16);}
    if (image) context.drawImage(image, selected.column * pack.atlas.cellWidth, selected.row * pack.atlas.cellHeight,
      pack.atlas.cellWidth, pack.atlas.cellHeight, 0, 0, width, height);
    const x = pack.anchors.ground.x * width, y = pack.anchors.ground.y * height;
    context.strokeStyle = '#d71953';context.lineWidth = 2;context.beginPath();context.moveTo(x - 9, y);context.lineTo(x + 9, y);context.moveTo(x, y - 9);context.lineTo(x, y + 9);context.stroke();
    caption.textContent = `${semantic} → ${selected.animation || '静止'}${selected.fallback ? '（回退）' : ''} · 第 ${selected.column + 1}/${selected.frameCount} 帧 · ${selected.totalMs} 毫秒 · 地面 ${pack.anchors.ground.x}, ${pack.anchors.ground.y}${image ? '' : ' · 请导入图片'}`;
    if (playing && !reducedMotion && !doc.hidden && !selected.static) timer = win.setTimeout(draw, Math.max(16, Math.min(250, selected.remainingMs)));
  }
  function populateClip() {
    const selected = pack.animations[clips.value]; if (!selected) return;
    clipName.node.value = clips.value;clipRow.node.value = selected.row;count.node.value = selected.frameCount;durations.node.value = selected.durationsMs.join(', ');
  }
  function sync() {
    stop();
    const names = [...new Set([...Object.keys(SEMANTIC_FALLBACKS), ...Object.keys(pack.actions)])]; if (!names.includes(semantic)) semantic = 'idle';
    semantics.replaceChildren(...names.map(name => el('option', name, {value: name})));semantics.value = semantic;
    clips.replaceChildren(...Object.keys(pack.animations).map(name => el('option', name, {value: name})));clips.value = resolveAction(pack, semantic).animation;
    columns.node.value = pack.atlas.columns;rows.node.value = pack.atlas.rows;anchorX.node.value = pack.anchors.ground.x;anchorY.node.value = pack.anchors.ground.y;
    json.value = JSON.stringify(pack, null, 2);populateClip();draw();
  }
  function applyJSON(text) {
    const next = parseCharacterJSON(text);
    generation++;
    if (image && (image.naturalWidth !== next.atlas.width || image.naturalHeight !== next.atlas.height || next.atlas.image !== pack.atlas.image)) {
      image = null;imageDataURL = undefined;
    }
    pack = next;sync();report(image ? 'JSON 校验通过，请检查预览和来源。' : 'JSON 校验通过；请自行选择对应图集，不会按 JSON 路径联网。');
  }
  function decode(source) {return new Promise((resolve, reject) => {const bitmap = new win.Image();bitmap.onload = () => resolve(bitmap);bitmap.onerror = () => reject(new Error('无法解码图片，请检查 PNG/WebP 文件。'));bitmap.src = source;});}
  function fileDataURL(file) {return new Promise((resolve, reject) => {const reader = new win.FileReader();reader.onload = () => resolve(reader.result);reader.onerror = () => reject(new Error('无法读取所选文件。'));reader.readAsDataURL(file);});}
  listen(semantics, 'change', () => {semantic = semantics.value;sync();});
  listen(clips, 'change', populateClip);
  listen(reduced.node, 'change', () => {reducedMotion = reduced.node.checked;stop();draw();});
  listen(canvas, 'click', event => {
    const rect = canvas.getBoundingClientRect();if (!rect.width || !rect.height) return;
    pack = setGroundAnchor(pack, Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));sync();report('地面锚点已更新，使用数值输入可以精调。');
  });
  listen(doc, 'visibilitychange', () => {if (doc.hidden) {stop();draw();}});
  listen(jsonFile.node, 'change', attempt(async () => {const file = jsonFile.node.files[0];if (!file) return;if (file.size > EDITOR_LIMITS.jsonBytes) throw new Error('角色 JSON 不能超过 64 KiB。');const token = ++generation, text = await file.text();if (!destroyed && token === generation) applyJSON(text);}));
  listen(imageFile.node, 'change', attempt(async () => {
    const file = imageFile.node.files[0];if (!file) return;if (file.size > EDITOR_LIMITS.imageBytes) throw new Error('图片不能超过 8 MiB。');
    const token = ++generation, bytes = new Uint8Array(await file.arrayBuffer()), info = inspectImageBytes(bytes);
    const url = await fileDataURL(new win.Blob([bytes], {type: info.mime})), loaded = await decode(url);
    if (destroyed || token !== generation) return;
    if (loaded.naturalWidth !== info.width || loaded.naturalHeight !== info.height) throw new Error('图片声明尺寸与解码结果不一致。');
    const next = clone(pack), sameSize = pack.atlas.width === info.width && pack.atlas.height === info.height;
    const filename = info.mime === 'image/png' ? 'character.png' : 'character.webp';
    if (!sameSize) {
      if (info.width > 4096 || info.height > 4096) throw new Error('新尺寸图集需先在 JSON 设置匹配的行列和单元尺寸，再导入图片。');
      next.atlas = {image: filename, width: info.width, height: info.height, columns: 1, rows: 1, cellWidth: info.width, cellHeight: info.height};
      next.animations = {idle: {row: 0, frameCount: 1, durationsMs: [900]}};next.neutral = {row: 0, column: 0};next.actions = {idle: 'idle'};delete next.lookDirections;
    } else next.atlas.image = filename;
    delete next.sha256;next.quality = [{id: 'standard', image: filename, scale: 1}];
    next.source = {kind: 'existing', author: '待填写素材作者', license: '待确认使用授权', reference: '用户主动选择的本地图集'};
    pack = validateCharacterPack(next);image = loaded;imageDataURL = url;sync();
    report(sameSize ? '图片已导入，动作布局保留。请填写真实来源及授权。' : '新尺寸图片已按 1×1 导入。设置网格、添加动作，再填写来源与授权。');
  }));
  sync();
  const initialGeneration = generation;
  const ready = (async () => {
    // Only this bundled image is eligible for automatic loading; imported JSON is data only.
    if (pack.atlas.image !== 'andromeda.png') {report('请自行导入此角色包的图集。');return;}
    try {
      const loaded = await decode(new URL('../assets/andromeda.png', import.meta.url).href);
      if (destroyed || generation !== initialGeneration) return;
      if (loaded.naturalWidth !== pack.atlas.width || loaded.naturalHeight !== pack.atlas.height) throw new Error('内置图片尺寸与角色包不同，请导入匹配图集。');
      image = loaded;draw();report('内置图集已载入。点击画面设置脚底锚点，或选择动作播放。');
    } catch (error) {report(error.message, true);}
  })();
  return {ready, snapshot: () => ({pack: clone(pack), hasImage: !!image, playing, reducedMotion, semantic, frame}),
    destroy() {if (destroyed) return;destroyed = true;generation++;stop();controller.abort();content.remove();image = null;imageDataURL = undefined;}};
}
