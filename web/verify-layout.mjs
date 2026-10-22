import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {findChromium} from '../scripts/ui-browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png'};
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (relative(root, path).startsWith('..')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(path); res.writeHead(200, {'Content-Type': mime[extname(path)] || 'application/octet-stream'}).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const viewports = [[390, 844], [844, 390], [1024, 768], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]];
const results = []; let browser, checks = 0;
try {
  browser = await chromium.launch({headless: true, executablePath: findChromium(), chromiumSandbox: true});
  await mkdir(resolve(root, 'qa'), {recursive: true});
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({viewport: {width: 1366, height: 768}, deviceScaleFactor: dpr});
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/web/demo.html'); await page.evaluate(() => demoGuide.ready);
    await page.evaluate(() => { const data = demoGuide.exportPreferences(); demoGuide.importPreferences({...data, preferences: {...data.preferences, reducedMotion: true, motion: 'still'}}); });
    // Source alpha bounds provide an independent shape reference: the rendered
    // pixels must keep its width/height ratio despite a different cell canvas.
    const expectedRatio = await page.evaluate(async () => {
      const image = new Image(); image.src = '/assets/studio/life-poses-v1.png'; await image.decode();
      const c = document.createElement('canvas'); c.width = 314; c.height = 418;
      const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0, 313.5, 418, 0, 0, 313.5, 418);
      const data = ctx.getImageData(0, 0, c.width, c.height).data; let left = c.width, right = 0, top = c.height, bottom = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] >= 64) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      return (right - left + 1) / (bottom - top + 1);
    });
    for (const visualStyle of ['classic', 'studio']) {
      await page.evaluate(style => { const data = demoGuide.exportPreferences(); demoGuide.importPreferences({...data, preferences: {...data.preferences, visualStyle: style}}); }, visualStyle);
      if (visualStyle === 'studio') await page.locator('canvas[data-studio-state=ready]').waitFor();
      for (const [width, height] of viewports) {
        await page.setViewportSize({width, height}); await page.waitForTimeout(60);
        const measured = await page.locator('[data-andromeda] canvas').evaluate(canvas => {
          const rect = canvas.getBoundingClientRect(), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let left = canvas.width, right = 0, top = canvas.height, bottom = 0;
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3] >= 64) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
          return {nativeRatio: canvas.width / canvas.height, cssRatio: rect.width / rect.height, visible: rect.width > 0 && rect.height > 0, within: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1, alphaRatio: (right - left + 1) / (bottom - top + 1), horizontalOverflow: document.documentElement.scrollWidth > innerWidth, actualDpr: devicePixelRatio};
        });
        assert.equal(measured.visible, true); assert.equal(measured.within, true); assert.equal(measured.horizontalOverflow, false);
        assert.ok(Math.abs(measured.cssRatio - measured.nativeRatio) < .001, `CSS distortion ${width}x${height}@${dpr}`); checks += 4;
        if (visualStyle === 'studio') { assert.ok(Math.abs(measured.alphaRatio - expectedRatio) / expectedRatio < .025, 'Studio source shape must remain proportional'); checks++; }
        await page.evaluate(() => demoGuide.open());
        const panelWithin = await page.getByRole('dialog', {name: '星璇向导'}).evaluate(panel => { const r = panel.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; });
        assert.equal(panelWithin, true, JSON.stringify({width, height, dpr, visualStyle, rect: await page.getByRole('dialog', {name: '星璇向导'}).evaluate(panel => panel.getBoundingClientRect().toJSON())})); checks++;
        await page.getByRole('button', {name: '关闭向导面板'}).click();
        if ((dpr === 1 && width === 1920) || (dpr === 2 && width === 390) || (dpr === 1.25 && width === 844)) await page.screenshot({path: resolve(root, `qa/web-layout-${visualStyle}-${width}x${height}-dpr${dpr}.png`)});
        results.push({visualStyle, width, height, dpr, ...measured, panelWithin});
      }
    }
    assert.deepEqual(errors, []); checks++; await context.close();
  }
  await writeFile(resolve(root, 'qa/web-layout-matrix.json'), JSON.stringify({method: 'CSS viewport dimensions and independent source/rendered alpha aspect ratios; DPR is Chromium device scale, not a claim of native monitor coverage.', checks, results}, null, 2) + '\n');
  console.log(`Layout QA passed: ${checks} assertions, ${results.length} viewport/style/DPR cases; qa/web-layout-matrix.json and six screenshots.`);
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
