import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname, relative, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {findChromium} from '../scripts/ui-browser.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fixtureImage;
const fixturePack = {schema: 'andromeda.character/v1', id: 'tiny-fixture', name: '测试角色', version: '1', source: {kind: 'original', author: 'Test suite', license: 'CC0', reference: 'Synthetic local canvas fixture'}, atlas: {image: 'atlas.png', width: 128, height: 80, cellWidth: 64, cellHeight: 80, columns: 2, rows: 1}, neutral: {row: 0, column: 1}, animations: {hello: {row: 0, frameCount: 2, durationsMs: [100, 200]}}, actions: {greet: 'hello'}};
const mime = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain; charset=utf-8'};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/__fixtures/')) {
    const name = pathname.split('/').at(-1);
    if (name === 'redirect.png') { res.writeHead(302, {Location: 'https://external.invalid/never-load.png'}).end(); return; }
    if (name.endsWith('.json')) {
      const image = name === 'external.json' ? 'https://external.invalid/never-load.png' : name === 'redirect.json' ? 'redirect.png' : name === 'slow.json' ? 'slow.png' : 'atlas.png';
      res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({...fixturePack, atlas: {...fixturePack.atlas, image}})); return;
    }
    if (name === 'slow.png') await new Promise(done => setTimeout(done, 350));
    if (!res.destroyed) res.writeHead(200, {'Content-Type': 'image/png'}).end(fixtureImage); return;
  }
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (relative(root, file).startsWith('..')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, {'Content-Type': mime[extname(file)] || 'application/octet-stream'}).end(body); } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser; let checks = 0;
const equal = (value, expected) => { assert.deepEqual(value, expected); checks++; };
try {
  browser = await chromium.launch({headless: true, executablePath: findChromium(), chromiumSandbox: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], studioRequests = [];
  page.on('request', request => { if (request.url().includes('/studio/')) studioRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  fixtureImage = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 128; c.height = 80; const ctx = c.getContext('2d'); ctx.fillStyle = '#9955dd'; ctx.fillRect(14, 12, 36, 60); ctx.fillStyle = '#3388ee'; ctx.fillRect(78, 12, 36, 60); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  await page.goto(base + '/web/demo.html'); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor();
  equal(await page.evaluate(() => demoGuide.getPreferences().motion), 'quiet'); equal(await page.evaluate(() => demoGuide.getPreferences().sound), false);
  equal(await page.evaluate(() => demoGuide.getPreferences().inputFeedback), false);
  equal(studioRequests, []);
  const transparent = await page.locator('[data-andromeda] canvas').boundingBox(), originalPosition = await page.evaluate(() => demoGuide.getPreferences());
  await page.mouse.click(transparent.x + 1, transparent.y + 1); equal(await page.getByRole('dialog', {name: '星璇向导'}).isHidden(), true);
  await page.mouse.move(transparent.x + 1, transparent.y + 1); await page.mouse.down(); await page.mouse.move(transparent.x - 30, transparent.y - 30); await page.mouse.up(); equal(await page.evaluate(() => demoGuide.getPreferences().x), originalPosition.x);
  const solidPoint = await page.locator('[data-andromeda] canvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data, rect = canvas.getBoundingClientRect();
    for (let y = 60; y < 150; y++) for (let x = 60; x < 130; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 240) return {x: rect.x + (x + .5) / canvas.width * rect.width, y: rect.y + (y + .5) / canvas.height * rect.height};
    throw new Error('No solid sprite pixel found');
  });
  await page.mouse.click(solidPoint.x, solidPoint.y); equal(await page.getByRole('dialog', {name: '星璇向导'}).isVisible(), true); await page.getByRole('button', {name: '关闭向导面板'}).click();
  await mkdir(resolve(root, 'qa'), {recursive: true}); await page.screenshot({path: resolve(root, 'qa/web-desktop.png'), fullPage: true});
  await page.locator('#open-guide').click(); equal(await page.getByRole('dialog', {name: '星璇向导'}).isVisible(), true);
  equal(await page.getByRole('link', {name: '回桌面陪伴', exact: true}).getAttribute('href'), 'andromeda-pet://open?target=companion');
  equal(await page.getByRole('link', {name: '还没安装？下载桌宠', exact: true}).getAttribute('href'), 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases');
  await page.evaluate(() => { document.querySelector('[data-andromeda]').shadowRoot.querySelector('a[href^="andromeda-pet:"]').addEventListener('click', event => { event.preventDefault(); window.protocolIntent = event.currentTarget.href; }, {once: true}); });
  await page.getByRole('link', {name: '回桌面陪伴', exact: true}).click(); equal(await page.evaluate(() => window.protocolIntent), 'andromeda-pet://open?target=companion');
  await page.getByRole('button', {name: '我想做 3D 模型', exact: true}).click(); equal(await page.getByRole('searchbox').inputValue(), '模型'); equal(await page.locator('[data-andromeda] .results').getByRole('link', {name: '模匠 Modelwright'}).count(), 1);
  await page.getByLabel('角色外观', {exact: true}).selectOption('studio'); await page.locator('[data-andromeda] canvas[data-studio-state=ready]').waitFor();
  equal(studioRequests.length, 1); await page.getByRole('button', {name: '关闭向导面板'}).click(); await page.evaluate(() => demoGuide.play('sleep'));
  equal(await page.locator('[data-andromeda] canvas').getAttribute('data-pose'), 'sleep');
  const studioBounds = await page.locator('[data-andromeda] canvas').boundingBox(); await page.mouse.click(studioBounds.x + 1, studioBounds.y + 1); equal(await page.getByRole('dialog', {name: '星璇向导'}).isHidden(), true);
  await page.mouse.move(studioBounds.x + 1, studioBounds.y + 1); await page.mouse.down(); await page.mouse.move(studioBounds.x - 40, studioBounds.y - 40); await page.mouse.up(); equal(await page.evaluate(() => demoGuide.getPreferences().x), originalPosition.x);
  await page.screenshot({path: resolve(root, 'qa/web-studio.png'), fullPage: true});
  await page.evaluate(() => demoGuide.open()); await page.getByLabel('角色外观', {exact: true}).selectOption('classic');
  await page.getByLabel('面板主题', {exact: true}).selectOption('dawn'); equal(await page.locator('[data-andromeda] .pet').getAttribute('data-theme'), 'dawn');
  await page.getByLabel('面板主题', {exact: true}).selectOption('night');
  await page.getByRole('searchbox').fill('下载'); equal(await page.getByRole('link', {name: '在哪里下载桌宠？'}).count(), 1);
  await page.getByRole('searchbox').fill('<script>'); equal(await page.locator('[data-andromeda] .results').textContent(), '暂时没找到。试试“下载”“Unity”“游戏”或“隐私”。');
  await page.getByLabel('输入节奏反馈（只计次数）', {exact: true}).check();
  await page.getByRole('button', {name: '关闭向导面板'}).click();
  await page.locator('#creation-note').focus(); equal(await page.locator('[data-andromeda] .character').isHidden(), true);
  await page.evaluate(() => {
    const note = document.querySelector('#creation-note');
    const blockedRead = () => { throw new Error('Input feedback must not read key/code/value'); };
    Object.defineProperty(note, 'value', {get: blockedRead, configurable: true});
    for (let i = 0; i < 3; i++) {
      const event = new KeyboardEvent('keydown', {bubbles: true});
      Object.defineProperties(event, {key: {get: blockedRead}, code: {get: blockedRead}}); note.dispatchEvent(event);
    }
    delete note.value;
  });
  await page.waitForTimeout(240); equal(await page.locator('[data-andromeda] .restore').textContent(), '✦ 输入中 · 3'); equal(await page.locator('[data-andromeda] .bubble').isHidden(), true);
  await page.waitForTimeout(1450); equal(await page.locator('[data-andromeda] .restore').textContent(), '✦ 星璇');
  await page.keyboard.press('a'); await page.waitForTimeout(240); equal(await page.locator('[data-andromeda] .restore').textContent(), '✦ 输入中 · 4');
  await page.locator('#finish-note').click(); await page.waitForTimeout(40); equal(await page.locator('[data-andromeda] .character').isVisible(), true);
  await page.evaluate(() => demoGuide.collapse()); await page.reload(); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor({state: 'attached'});
  equal(await page.locator('[data-andromeda] .restore').isVisible(), true);
  await page.getByRole('button', {name: '展开星璇向导'}).click(); await page.getByRole('button', {name: '关闭向导面板'}).click();
  const canvas = page.locator('[data-andromeda] canvas'), before = await canvas.boundingBox(); await canvas.focus(); await page.keyboard.press('ArrowLeft'); const after = await canvas.boundingBox(); assert.ok(after.x < before.x); checks++;
  equal(await page.evaluate(() => demoGuide.receiveTask({userId: 'owner', eventId: 'e1', taskId: 't1', status: 'completed'})), false);
  await page.evaluate(async () => {
    demoGuide.destroy(); window.testSession = {authenticated: true, userId: 'one'};
    window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({getSession: () => window.testSession}); await demoGuide.ready;
  });
  equal(await page.evaluate(() => demoGuide.receiveTask({userId: 'two', eventId: 'e1', taskId: 't1', status: 'completed'})), false);
  equal(await page.evaluate(() => demoGuide.receiveTask({userId: 'one', eventId: 'e1', taskId: 't1', status: 'completed', text: '属于用户一'})), true);
  equal(await page.locator('[data-andromeda] .bubble').textContent(), '属于用户一×');
  await page.evaluate(() => { window.testSession = null; demoGuide.refreshSession(); }); equal(await page.locator('[data-andromeda] .bubble').isHidden(), true);
  await page.evaluate(() => demoGuide.destroy()); equal(await page.locator('[data-andromeda]').count(), 0);
  await page.setViewportSize({width: 390, height: 844}); await page.reload(); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor({state: 'attached'});
  await page.evaluate(() => { demoGuide.restore(); demoGuide.open(); }); equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const panelBox = await page.getByRole('dialog').boundingBox(); assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 390); checks++;
  await page.screenshot({path: resolve(root, 'qa/web-mobile.png'), fullPage: true});
  await page.emulateMedia({reducedMotion: 'reduce'}); await page.getByRole('button', {name: '关闭向导面板'}).click(); await page.evaluate(() => demoGuide.play('greet'));
  equal(await canvas.getAttribute('data-column'), '0');
  const fallbackPage = await browser.newPage(); fallbackPage.on('pageerror', error => errors.push(error.message));
  await fallbackPage.route('**/manifest.json', route => route.abort()); await fallbackPage.goto(base + '/web/demo.html');
  await fallbackPage.locator('[data-andromeda] canvas[data-asset-state=fallback]').waitFor(); await fallbackPage.locator('#open-guide').click(); equal(await fallbackPage.getByRole('searchbox').isVisible(), true);
  const custom = await browser.newPage({viewport: {width: 1000, height: 900}}), externalRequests = [];
  custom.on('pageerror', error => errors.push(error.message)); custom.on('request', request => { if (request.url().startsWith('https://external.invalid')) externalRequests.push(request.url()); });
  await custom.goto(base + '/web/demo.html');
  await custom.evaluate(async () => { demoGuide.destroy(); window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: '/__fixtures/character.json', storageKey: 'qa.custom'}); await demoGuide.ready; });
  equal(await custom.locator('[data-andromeda] canvas').getAttribute('data-character-id'), 'tiny-fixture');
  equal(await custom.locator('[data-andromeda] canvas').evaluate(c => [c.width, c.height]), [64, 80]);
  equal(await custom.evaluate(() => { demoGuide.play('greet'); return document.querySelector('[data-andromeda]').shadowRoot.querySelector('canvas').dataset.column; }), '0');
  await custom.waitForTimeout(180); equal(await custom.locator('[data-andromeda] canvas').getAttribute('data-column'), '1');
  equal(await custom.evaluate(() => demoGuide.play('sleep')), true); equal(await custom.locator('[data-andromeda] canvas').getAttribute('data-column'), '1');
  const bounds = await custom.locator('[data-andromeda] canvas').boundingBox(); assert.ok(Math.abs(bounds.width / bounds.height - 64 / 80) < .01); checks++;
  await custom.evaluate(async () => { demoGuide.destroy(); window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({assetBase: '/__fixtures/', storageKey: 'qa.assetBase'}); await demoGuide.ready; });
  equal(await custom.locator('[data-andromeda] canvas').getAttribute('data-asset-state'), 'ready');
  for (const url of ['/__fixtures/external.json', '/__fixtures/redirect.json', 'https://external.invalid/pack.json']) {
    await custom.evaluate(async url => { demoGuide.destroy(); window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: url, storageKey: 'qa.rejected'}); await demoGuide.ready; }, url);
    equal(await custom.locator('[data-andromeda] canvas').getAttribute('data-asset-state'), 'fallback');
  }
  equal(externalRequests, []);
  const waitingImage = custom.waitForRequest('**/__fixtures/slow.png');
  await custom.evaluate(async () => { demoGuide.destroy(); window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: '/__fixtures/slow.json', storageKey: 'qa.destroy'}); });
  await waitingImage; await custom.evaluate(async () => { demoGuide.destroy(); await demoGuide.ready; }); equal(await custom.locator('[data-andromeda]').count(), 0);
  await custom.evaluate(async () => {
    const article = document.createElement('article'); article.id = 'reading-fixture'; article.style.cssText = 'height:480px;padding:24px;background:#111;color:white'; article.textContent = '公开项目阅读区域，内容始终可访问。'; document.body.prepend(article); scrollTo(0, 0);
    window.mountReadingFixture = async () => { window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: '/__fixtures/character.json', storageKey: 'qa.reading', reading: {kind: 'project', id: 'demo-project', selector: '#reading-fixture', title: '测试项目', minimumVisibleMs: 1000}}); await demoGuide.ready; demoGuide.open(); };
    await mountReadingFixture();
  });
  equal(await custom.getByLabel('本页阅读进度彩蛋', {exact: true}).isChecked(), false);
  await custom.getByRole('button', {name: '收下这页星光', exact: true}).click(); equal(await custom.locator('[data-andromeda] .reading-card').textContent(), '本页小彩蛋✦ 测试项目的星光，已经收好了。关闭本页彩蛋');
  await custom.evaluate(async () => { demoGuide.destroy(); await mountReadingFixture(); }); equal(await custom.getByRole('button', {name: '收下这页星光', exact: true}).count(), 0);
  await custom.getByRole('button', {name: '关闭本页彩蛋', exact: true}).click(); equal(await custom.locator('[data-andromeda] .reading-card').textContent(), ''); equal(await custom.locator('#reading-fixture').isVisible(), true);
  await custom.evaluate(async () => { demoGuide.destroy(); localStorage.removeItem('qa.reading.reading.demo-project'); await mountReadingFixture(); });
  await custom.getByLabel('本页阅读进度彩蛋', {exact: true}).check(); await custom.waitForTimeout(1150);
  assert.match(await custom.locator('[data-andromeda] .reading-card').textContent(), /已点亮一颗星光/); checks++;
  equal(await custom.locator('[data-andromeda] .bubble').isHidden(), true);
  await custom.evaluate(async () => {
    demoGuide.destroy(); const button = document.createElement('button'); button.id = 'critical-fixture'; button.type = 'button'; button.textContent = '主要操作'; button.style.cssText = 'position:fixed;right:16px;bottom:16px;width:200px;height:180px;z-index:10'; document.body.append(button);
    window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: '/__fixtures/character.json', storageKey: 'qa.avoid', avoidSelectors: ['#critical-fixture']}); await demoGuide.ready;
  });
  for (const viewport of [{width: 1000, height: 900}, {width: 390, height: 844}]) {
    await custom.setViewportSize(viewport); await custom.waitForTimeout(100);
    const overlap = await custom.evaluate(() => { const pet = document.querySelector('[data-andromeda]').shadowRoot.querySelector('.pet').getBoundingClientRect(), button = document.querySelector('#critical-fixture').getBoundingClientRect(); return pet.left < button.right && pet.right > button.left && pet.top < button.bottom && pet.bottom > button.top; });
    equal(overlap, false); equal(await custom.evaluate(() => [demoGuide.getPreferences().x, demoGuide.getPreferences().y]), [1, 1]);
  }
  await custom.evaluate(() => { document.querySelector('#critical-fixture').style.cssText = 'position:fixed;left:0;right:0;top:60px;bottom:60px;width:auto;height:auto'; dispatchEvent(new Event('resize')); });
  equal(await custom.locator('[data-andromeda] .restore').isVisible(), true);
  await custom.getByRole('button', {name: '展开星璇向导'}).click(); equal(await custom.locator('[data-andromeda] .character').isVisible(), true); equal(await custom.getByRole('dialog').isVisible(), true);
  await custom.getByRole('button', {name: '关闭向导面板'}).click(); equal(await custom.locator('[data-andromeda] .restore').isVisible(), true);
  await custom.evaluate(() => { document.querySelector('#critical-fixture').remove(); dispatchEvent(new Event('resize')); }); equal(await custom.locator('[data-andromeda] .character').isVisible(), true);
  const delayedImport = await custom.evaluate(async () => {
    demoGuide.destroy(); let finish, writes = 0;
    window.demoGuide = (await import('/web/andromeda.mjs')).mountAndromeda({characterPackUrl: '/__fixtures/character.json', storageKey: 'qa.destroy.file', onPreferencesChange: () => { writes++; }});
    await demoGuide.ready; demoGuide.open();
    const input = document.querySelector('[data-andromeda]').shadowRoot.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', {value: [{size: 100, text: () => new Promise(done => { finish = done; })}]});
    input.dispatchEvent(new Event('change')); demoGuide.destroy();
    finish(JSON.stringify({schema: 'andromeda.preferences/v1', preferences: {sound: true}}));
    await Promise.resolve(); await Promise.resolve();
    return {writes, stored: localStorage.getItem('qa.destroy.file'), sound: demoGuide.getPreferences().sound, widgets: document.querySelectorAll('[data-andromeda]').length};
  });
  equal(delayedImport, {writes: 0, stored: null, sound: false, widgets: 0});
  equal(errors, []); console.log(`Web browser QA passed: ${checks} assertions; qa/web-desktop.png, qa/web-mobile.png`);
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
