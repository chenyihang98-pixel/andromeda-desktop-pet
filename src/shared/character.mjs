/** Character-pack metadata only: validation never executes scripts or fetches resources. */
export const CHARACTER_SCHEMA = 'andromeda.character/v1';
export const SEMANTIC_FALLBACKS = Object.freeze({
  idle: ['idle'], greet: ['waving', 'idle'], happy: ['jumping', 'waving', 'idle'],
  think: ['running', 'waiting', 'idle'], read: ['review', 'waiting', 'idle'],
  question: ['failed', 'waiting', 'idle'], pet: ['waving', 'idle'],
  sleep: ['waiting', 'idle'], notify: ['waving', 'waiting', 'idle'],
  drag: ['idle'], drop: ['jumping', 'idle'], 'move-left': ['running-left', 'idle'],
  'move-right': ['running-right', 'idle'], 'point-left': ['waving', 'idle'], 'point-right': ['waving', 'idle'],
});
const DEFAULT_ANCHORS = Object.freeze({ ground: { x: 0.5, y: 0.97 }, body: { x: 0.5, y: 0.55 },
  face: { x: 0.5, y: 0.37 }, dialogue: { x: 0.8, y: 0.15 } });
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('角色包需要普通对象');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('角色包不能包含访问器');
  }
  return value;
}
function fields(value, names) {
  record(value);
  if (Object.keys(value).some(key => !names.includes(key))) throw new TypeError('角色包包含未知字段');
  return value;
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new TypeError('角色包文本无效');
  return value.trim();
}
function name(value) { const result = text(value, 64); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result)) throw new TypeError('角色包名称无效'); return result; }
function integer(value, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new TypeError('角色包尺寸/时间无效'); return value; }
function point(value) {
  fields(value, ['x', 'y']);
  for (const coordinate of [value.x, value.y]) if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) throw new TypeError('锚点必须是0–1坐标');
  return { x: value.x, y: value.y };
}
function resource(value) {
  const path = text(value, 200);
  if (/[:?#\\%]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')
    || !/\.(png|webp)$/i.test(path)) throw new TypeError('角色资源必须是包内 PNG/WebP 相对路径');
  return path;
}

export function validateCharacterPack(value) {
  fields(value, ['schema', 'id', 'name', 'version', 'description', 'source', 'atlas', 'neutral', 'animations', 'lookDirections', 'actions', 'anchors', 'quality', 'sha256']);
  if (value.schema !== CHARACTER_SCHEMA) throw new TypeError('不支持的角色包版本');
  const atlas = fields(value.atlas, ['image', 'width', 'height', 'columns', 'rows', 'cellWidth', 'cellHeight']);
  const cleanAtlas = { image: resource(atlas.image), width: integer(atlas.width, 1, 16384), height: integer(atlas.height, 1, 16384),
    columns: integer(atlas.columns, 1, 64), rows: integer(atlas.rows, 1, 128),
    cellWidth: integer(atlas.cellWidth, 1, 4096), cellHeight: integer(atlas.cellHeight, 1, 4096) };
  if (cleanAtlas.columns * cleanAtlas.cellWidth !== cleanAtlas.width || cleanAtlas.rows * cleanAtlas.cellHeight !== cleanAtlas.height
    || cleanAtlas.width * cleanAtlas.height > 64 * 1024 * 1024) throw new TypeError('图集布局与尺寸不一致或过大');
  const animations = {};
  record(value.animations);
  if (!Object.keys(value.animations).length || Object.keys(value.animations).length > 128) throw new TypeError('动作数量无效');
  for (const [key, animation] of Object.entries(value.animations)) {
    name(key); fields(animation, ['row', 'frameCount', 'durationsMs']);
    const frameCount = integer(animation.frameCount, 1, cleanAtlas.columns);
    if (!Array.isArray(animation.durationsMs) || animation.durationsMs.length !== frameCount) throw new TypeError('动作帧与时长不一致');
    animations[key] = { row: integer(animation.row, 0, cleanAtlas.rows - 1), frameCount,
      durationsMs: animation.durationsMs.map(duration => integer(duration, 16, 60_000)) };
  }
  const neutral = fields(value.neutral, ['row', 'column']);
  const actions = {};
  record(value.actions ?? {});
  if (Object.keys(value.actions ?? {}).length > 128) throw new TypeError('语义动作数量过多');
  for (const [semantic, animation] of Object.entries(value.actions ?? {})) {
    name(semantic); name(animation);
    if (!Object.hasOwn(animations, animation)) throw new TypeError('语义动作指向不存在的动画');
    Object.defineProperty(actions, semantic, { value: animation, enumerable: true, configurable: true, writable: true });
  }
  const anchors = {};
  fields(value.anchors ?? {}, ['ground', 'body', 'face', 'dialogue']);
  for (const key of Object.keys(DEFAULT_ANCHORS)) anchors[key] = point(value.anchors?.[key] ?? DEFAULT_ANCHORS[key]);
  const source = fields(value.source, ['kind', 'author', 'license', 'reference']);
  if (!['original', 'generated', 'commissioned', 'existing'].includes(source.kind)) throw new TypeError('需要记录素材来源类型');
  const result = { schema: CHARACTER_SCHEMA, id: name(value.id), name: text(value.name, 80), version: text(value.version, 40),
    description: text(value.description ?? value.name, 1000),
    source: { kind: source.kind, author: text(source.author, 200), license: text(source.license, 200), reference: text(source.reference, 500) },
    atlas: cleanAtlas, neutral: { row: integer(neutral.row, 0, cleanAtlas.rows - 1), column: integer(neutral.column, 0, cleanAtlas.columns - 1) },
    animations, actions, anchors, quality: [] };
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw new TypeError('素材哈希无效');
    result.sha256 = value.sha256.toLowerCase();
  }
  if (value.lookDirections !== undefined) {
    const look = fields(value.lookDirections, ['rows', 'degreesClockwise']);
    if (!Array.isArray(look.rows) || !look.rows.length || look.rows.length > cleanAtlas.rows
      || !Array.isArray(look.degreesClockwise) || !look.degreesClockwise.length || look.degreesClockwise.length > look.rows.length * cleanAtlas.columns) throw new TypeError('注视布局无效');
    const degrees = look.degreesClockwise.map(degree => {
      if (!Number.isFinite(degree) || degree < 0 || degree >= 360) throw new TypeError('注视角度无效');
      return degree;
    });
    if (new Set(degrees).size !== degrees.length || new Set(look.rows).size !== look.rows.length) throw new TypeError('注视角度或行重复');
    result.lookDirections = { rows: look.rows.map(row => integer(row, 0, cleanAtlas.rows - 1)), degreesClockwise: degrees };
  }
  if (value.quality !== undefined && (!Array.isArray(value.quality) || value.quality.length > 8)) throw new TypeError('质量档数量无效');
  const qualityIds = new Set();
  for (const tier of value.quality ?? [{ id: 'standard', image: atlas.image, scale: 1 }]) {
    fields(tier, ['id', 'image', 'scale']);
    const tierId = name(tier.id);
    if (qualityIds.has(tierId) || !Number.isFinite(tier.scale) || tier.scale < 0.25 || tier.scale > 4) throw new TypeError('质量档无效');
    qualityIds.add(tierId); result.quality.push({ id: tierId, image: resource(tier.image), scale: tier.scale });
  }
  return result;
}

/** Wrap the existing atlas without editing it or claiming missing poses exist. */
export function characterPackFromAtlas(manifest, metadata = {}) {
  record(manifest); fields(metadata, ['id', 'name', 'version', 'author', 'license', 'reference']);
  if (manifest.schema !== 'andromeda.sprite-atlas/v1') throw new TypeError('不支持的素材图集格式');
  record(manifest.atlas); record(manifest.animations);
  const animations = {};
  for (const [key, entry] of Object.entries(manifest.animations)) {
    record(entry);
    Object.defineProperty(animations, key, { value: { row: entry.row, frameCount: entry.frameCount, durationsMs: entry.durationsMs }, enumerable: true });
  }
  const actions = {};
  for (const [semantic, animation] of Object.entries({ idle: 'idle', greet: 'waving', happy: 'jumping', think: 'running', read: 'review', question: 'failed',
    'move-left': 'running-left', 'move-right': 'running-right' })) if (Object.hasOwn(animations, animation)) actions[semantic] = animation;
  return validateCharacterPack({ schema: CHARACTER_SCHEMA, id: metadata.id ?? 'andromeda', name: metadata.name ?? manifest.name,
    version: metadata.version ?? '1.0.0', description: manifest.description ?? manifest.name,
    source: { kind: 'existing', author: metadata.author ?? 'Andromeda project', license: metadata.license ?? 'UNLICENSED', reference: metadata.reference ?? 'NOTICE.md' },
    atlas: { image: manifest.image, ...Object.fromEntries(['width', 'height', 'columns', 'rows', 'cellWidth', 'cellHeight'].map(key => [key, manifest.atlas[key]])) },
    neutral: manifest.neutral, animations, actions, ...(manifest.sha256 ? { sha256: manifest.sha256 } : {}),
    ...(manifest.lookDirections ? { lookDirections: { rows: manifest.lookDirections.rows, degreesClockwise: manifest.lookDirections.degreesClockwise } } : {}) });
}

/** Returns a checked animation or a neutral pose; fallback is explicit in the result. */
export function resolveAction(pack, semantic, { reducedMotion = false } = {}) {
  const character = validateCharacterPack(pack);
  name(semantic);
  if (typeof reducedMotion !== 'boolean') throw new TypeError('减少动画选项无效');
  const declared = Object.hasOwn(character.actions, semantic) ? character.actions[semantic] : null;
  const candidates = declared ? [declared] : Object.hasOwn(SEMANTIC_FALLBACKS, semantic) ? SEMANTIC_FALLBACKS[semantic] : ['idle'];
  const animation = candidates.find(key => Object.hasOwn(character.animations, key));
  const data = animation ? character.animations[animation] : null;
  return { semantic, animation: animation ?? null, fallback: !declared, static: reducedMotion || !data,
    row: data?.row ?? character.neutral.row, column: data ? 0 : character.neutral.column,
    frameCount: reducedMotion || !data ? 1 : data.frameCount,
    durationsMs: reducedMotion || !data ? [900] : [...data.durationsMs], anchor: { ...character.anchors.ground } };
}
export function resolveSemanticAction(pack, semantic) { return resolveAction(pack, semantic).animation; }
