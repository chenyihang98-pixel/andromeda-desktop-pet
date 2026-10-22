import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_FILES = Object.freeze([
  'web/andromeda.mjs', 'web/policy.mjs', 'web/studio.mjs', 'web/character-loader.mjs', 'web/reading.mjs', 'web/widget.css', 'web/demo.html', 'web/demo.mjs', 'web/demo.css', 'web/README.md',
  'src/animation.mjs', 'src/shared/companion.mjs', 'src/shared/character.mjs', 'src/shared/behavior.mjs', 'src/shared/site-content.mjs',
  'assets/andromeda.png', 'assets/neutral.png', 'assets/manifest.json', 'assets/studio/life-poses-v1.png', 'NOTICE.md',
]);
export async function buildWeb(output = resolve(root, 'dist/web')) {
  const destination = resolve(output), relativeOutput = relative(resolve(root, 'dist'), destination);
  if (!relativeOutput || relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) throw new Error('Web 构建目录必须位于本仓库 dist 下的专用子目录');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const files = [];
  for (const path of WEB_FILES) {
    const target = resolve(destination, path), source = resolve(root, path);
    await mkdir(dirname(target), {recursive: true});
    const original = await readFile(source);
    const bytes = /\.(mjs|css|html|json|md)$/.test(path) ? Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n')) : original;
    await writeFile(target, bytes);
    files.push({path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  const manifest = {schema: 'andromeda.web-build/v1', version: pkg.version, entry: 'web/andromeda.mjs', demo: 'web/demo.html', files};
  await writeFile(resolve(destination, 'sdk-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {destination, manifest};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildWeb(); console.log(`Web SDK ${result.manifest.version}: ${result.destination} (${result.manifest.files.length} files; no publishing)`);
}
