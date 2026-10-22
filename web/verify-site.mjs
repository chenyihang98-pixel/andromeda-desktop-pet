import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname, relative, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {findChromium} from '../scripts/ui-browser.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('请提供待验收的网站构建目录：node web/verify-site.mjs ../site-project/dist');
const root = resolve(process.argv[2]);
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'};
const server = createServer(async (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(root, '.' + pathname); if (relative(root, file).startsWith('..')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, {'Content-Type': mime[extname(file)] || 'application/octet-stream'}).end(body); } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); let browser, checks = 0;
const equal = (value, expected) => { assert.deepEqual(value, expected); checks++; };
const avoidsControls = page => page.evaluate(() => {
  const pet = document.querySelector('[data-andromeda]').shadowRoot.querySelector('.pet').getBoundingClientRect();
  const targets = document.querySelectorAll('[data-download],.btn--primary,form button[type=submit],form input[type=submit],[data-game-reload],[data-game-fullscreen],[data-nav-toggle]');
  return [...targets].every(target => { const rect = target.getBoundingClientRect(); return !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || !(pet.left < rect.right && pet.right > rect.left && pet.top < rect.bottom && pet.bottom > rect.top); });
});
try {
  browser = await chromium.launch({headless: true, executablePath: findChromium(), chromiumSandbox: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], failed = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/tools/xingxuan/', '/tools/modelwright/', '/tools/xiaoren-luandou/', '/about/', '/404.html']) {
    console.log(`Checking local site ${path}`);
    await page.goto(base + path); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor({state: 'attached'});
    equal(await page.locator('[data-andromeda]').count(), 1); equal(await page.locator('main h1').count(), 1);
    // The game's lazy iframe may focus its own canvas after loading. Return keyboard
    // focus to the host explicitly before checking the host's companion controls.
    if (path === '/tools/xiaoren-luandou/' || await page.locator('[data-andromeda] canvas').isHidden()) { await page.locator('main').focus(); await page.waitForTimeout(80); }
    await page.locator('[data-andromeda] canvas').click(); equal(await page.getByRole('searchbox').isVisible(), true);
    equal(await page.getByLabel('本页阅读进度彩蛋', {exact: true}).count(), ['/tools/xingxuan/', '/tools/modelwright/'].includes(path) ? 1 : 0);
    if (path.includes('modelwright')) { await page.getByRole('searchbox').fill('模匠'); assert.match(await page.locator('[data-andromeda] .results').textContent(), /0\.1\.7/); checks++; }
    await page.getByRole('button', {name: '关闭向导面板'}).click();
    equal(await avoidsControls(page), true);
    if (path === '/tools/xiaoren-luandou/') {
      equal(await page.locator('[data-game-frame] iframe').count(), 1);
      await page.locator('[data-game-reload]').click();
      await page.waitForTimeout(100); equal(await page.locator('[data-andromeda] .restore').isVisible(), true);
      await page.locator('[data-game-hint]').click();
      await page.waitForTimeout(40); equal(await page.locator('[data-andromeda] .character').isVisible(), true);
      if (await page.evaluate(() => document.fullscreenEnabled)) {
        await page.locator('[data-game-fullscreen]').click(); await page.waitForTimeout(100); equal(await page.locator('[data-andromeda] .pet').isHidden(), true);
        await page.evaluate(() => document.exitFullscreen());
      }
    }
  }
  await page.goto(base + '/'); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor(); await page.locator('[data-andromeda] canvas').click();
  await page.getByRole('searchbox').fill('0.5.1'); assert.match(await page.locator('[data-andromeda] .results').textContent(), /小人乱斗/); checks++;
  await page.getByRole('button', {name: '带我逛逛'}).click(); equal(await page.locator('[data-andromeda] .highlight').isVisible(), true);
  await page.getByRole('button', {name: '结束导览'}).click();
  await mkdir(resolve(repo, 'qa'), {recursive: true}); await page.waitForTimeout(2600); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({path: resolve(repo, 'qa/web-starwright-integrated.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844}); await page.goto(base + '/'); await page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor();
  await page.locator('[data-nav-toggle]').click(); equal(await page.locator('[data-header]').evaluate(node => node.classList.contains('nav-open')), true);
  await page.locator('[data-nav-toggle]').click(); await page.locator('[data-andromeda] canvas').click();
  await page.waitForTimeout(2600); await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: resolve(repo, 'qa/web-starwright-mobile.png'), fullPage: true});
  equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', {name: '关闭向导面板'}).click(); equal(await avoidsControls(page), true);
  await page.locator('[data-download]').last().scrollIntoViewIfNeeded(); await page.waitForTimeout(150); equal(await avoidsControls(page), true);
  equal(errors, []); equal(failed.filter(url => !url.endsWith('/favicon.ico')), []);
  console.log(`Starwright local integration QA passed: ${checks} assertions across six pages. No remote writes.`);
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
