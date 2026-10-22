import {validateCharacterPack, characterPackFromAtlas} from '../src/shared/character.mjs';

/** Web assets stay on the host origin. Fetch callers must also reject redirects. */
export function sameOriginAsset(value, base, origin) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.hash) throw new TypeError('角色资源必须位于宿主同源路径');
  return url;
}

export function prepareWebCharacter(data, manifestUrl, origin) {
  const source = sameOriginAsset(manifestUrl, manifestUrl, origin);
  const legacy = data?.schema !== 'andromeda.character/v1';
  const normalized = data?.schema === 'andromeda.sprite-atlas/web-v1'
    ? {...data, schema: 'andromeda.sprite-atlas/v1', name: data.name || '星璇', description: data.description || '星璇网页精灵图集'} : data;
  const pack = legacy ? characterPackFromAtlas(normalized) : validateCharacterPack(normalized);
  const imageUrl = sameOriginAsset(pack.atlas.image, source, origin);
  // The validator allows only package-relative PNG/WebP paths, never traversal,
  // data URLs, scripts, absolute paths, query strings or external image URLs.
  return {pack, imageUrl, legacy, manifest: {
    image: pack.atlas.image, atlas: pack.atlas, neutral: pack.neutral,
    animations: pack.animations, ...(pack.lookDirections ? {lookDirections: pack.lookDirections} : {}),
  }};
}

export function nearestLookCell(look, columns, dx, dy) {
  if (!look?.degreesClockwise?.length || !Number.isInteger(columns) || columns < 1) return null;
  const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  let index = 0, distance = Infinity;
  look.degreesClockwise.forEach((candidate, i) => {
    const delta = Math.abs(candidate - angle), circular = Math.min(delta, 360 - delta);
    if (circular < distance) { distance = circular; index = i; }
  });
  return {row: look.rows[Math.floor(index / columns)], column: index % columns};
}
