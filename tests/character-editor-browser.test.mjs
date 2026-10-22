import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {PNG} from 'pngjs';
import {findChromium} from '../scripts/ui-browser.mjs';

test('real editor imports local images, previews actions, edits anchors and exports without fetching JSON paths', {timeout: 30000}, async t => {
  let executablePath;
  try {executablePath = findChromium();} catch (error) {t.skip(error.message);return;}
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), files = new Set([
    '/src/character-editor.mjs', '/src/shared/character.mjs', '/assets/manifest.json', '/assets/andromeda.png',
  ]), requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');requests.push(url.pathname);
    if (url.pathname === '/') {res.writeHead(200, {'Content-Type': 'text/html'}).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>编辑器验收</title><body><div id="editor"></div><script type="module" src="/fixture.mjs"></script></body></html>');return;}
    if (url.pathname === '/fixture.mjs') {res.writeHead(200, {'Content-Type': 'text/javascript'}).end(`import {mountCharacterEditor} from '/src/character-editor.mjs';import {characterPackFromAtlas} from '/src/shared/character.mjs';const manifest=await(await fetch('/assets/manifest.json')).json();window.exports=[];window.editor=mountCharacterEditor({root:document.querySelector('#editor'),initialPack:characterPackFromAtlas(manifest),onExport:async value=>{window.exports.push(value);return true;}});await editor.ready;document.body.dataset.ready='true';`);return;}
    if (!files.has(url.pathname)) {res.writeHead(404).end();return;}
    try {res.writeHead(200, {'Content-Type': {'.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png'}[extname(url.pathname)]}).end(await readFile(resolve(repo, '.' + url.pathname)));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath, chromiumSandbox: true});
    const page = await browser.newPage({viewport: {width: 1050, height: 1200}}), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {if (!route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`)) {external.push(route.request().url());return route.abort();}return route.continue();});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('body[data-ready=true]').waitFor();
    assert.equal(await page.evaluate(() => editor.snapshot().hasImage), true);
    await page.getByLabel('动作语义', {exact: true}).selectOption('greet');
    assert.equal(await page.getByLabel('语义对应动画', {exact: true}).inputValue(), 'waving');
    await page.getByRole('button', {name: '播放预览', exact: true}).click();
    await page.waitForFunction(() => editor.snapshot().frame > 0);
    await page.getByLabel('减少动画预览', {exact: true}).check();
    await page.getByRole('button', {name: '播放预览', exact: true}).click();
    await page.waitForTimeout(200);assert.equal(await page.evaluate(() => editor.snapshot().frame), 0);
    const canvas = page.getByLabel('角色预览，点击设置脚底锚点', {exact: true});
    await canvas.click({position: {x: 96, y: 312}});
    const anchor = await page.evaluate(() => editor.snapshot().pack.anchors.ground);
    assert.ok(Math.abs(anchor.x - .25) < .01 && Math.abs(anchor.y - .75) < .01);
    const before = await page.evaluate(() => editor.snapshot().pack);
    await page.getByLabel('角色包 JSON', {exact: true}).fill(JSON.stringify({...before, atlas: {...before.atlas, image: 'https://example.test/unwanted.png'}}));
    await page.getByRole('button', {name: '应用 JSON', exact: true}).click();
    assert.equal(await page.getByRole('status').getAttribute('data-error'), 'true');
    assert.deepEqual(await page.evaluate(() => editor.snapshot().pack), before);
    await page.getByLabel('导入角色 JSON', {exact: true}).setInputFiles({name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({...before, atlas: {...before.atlas, image: 'chosen-locally.png'}}))});
    await page.waitForFunction(() => editor.snapshot().pack.atlas.image === 'chosen-locally.png');
    assert.equal(await page.evaluate(() => editor.snapshot().hasImage), false);
    assert.equal(requests.some(path => path.includes('chosen-locally')), false);
    await page.getByRole('button', {name: '导出角色包与所选图集', exact: true}).click();
    assert.equal(await page.evaluate(() => exports.length), 0);
    const sample = new PNG({width: 16, height: 8});
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {const i = (y * 16 + x) * 4;sample.data[i] = x < 8 ? 220 : 40;sample.data[i + 1] = x < 8 ? 40 : 220;sample.data[i + 3] = 255;}
    await page.getByLabel('导入图集', {exact: true}).setInputFiles({name: 'sample.png', mimeType: 'image/png', buffer: PNG.sync.write(sample)});
    await page.waitForFunction(() => editor.snapshot().pack.atlas.image === 'character.png' && editor.snapshot().hasImage);
    assert.equal(await page.evaluate(() => editor.snapshot().pack.atlas.columns), 1);
    await page.getByLabel('图集列数', {exact: true}).fill('2');await page.getByRole('button', {name: '应用网格', exact: true}).click();
    await page.getByLabel('动作名', {exact: true}).fill('waving');await page.getByLabel('动作所在行（从 0 开始）', {exact: true}).fill('0');
    await page.getByLabel('帧数', {exact: true}).fill('2');await page.getByLabel('每帧毫秒（逗号分隔，单值重复）', {exact: true}).fill('80, 120');
    await page.getByRole('button', {name: '保存动作', exact: true}).click();
    await page.getByLabel('动作语义', {exact: true}).selectOption('greet');await page.getByLabel('语义对应动画', {exact: true}).selectOption('waving');
    await page.getByRole('button', {name: '保存语义映射', exact: true}).click();
    await page.getByRole('button', {name: '导出角色包与所选图集', exact: true}).click();
    await page.waitForFunction(() => exports.length === 1);
    const output = await page.evaluate(() => ({pack: exports[0].pack, image: exports[0].imageDataURL.slice(0, 22)}));
    assert.equal(output.pack.actions.greet, 'waving');assert.deepEqual(output.pack.animations.waving.durationsMs, [80, 120]);assert.equal(output.image, 'data:image/png;base64,');
    assert.equal(output.pack.sha256, undefined);assert.match(output.pack.source.license, /待确认/);
    await page.getByLabel('减少动画预览', {exact: true}).uncheck();await page.getByRole('button', {name: '播放预览', exact: true}).click();
    await page.waitForFunction(() => editor.snapshot().frame === 1);
    await mkdir(resolve(repo, 'qa'), {recursive: true});await page.screenshot({path: resolve(repo, 'qa/character-editor.png'), fullPage: true});
    await page.evaluate(() => {editor.destroy();editor.destroy();});assert.equal(await page.locator('#editor').textContent(), '');
    assert.equal(await page.evaluate(() => editor.snapshot().playing), false);assert.deepEqual(external, []);assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(done => server.close(done));
  }
});
