import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname, extname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findChromium} from '../scripts/ui-browser.mjs';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2] || 'sample';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a simple measurement label');
const siteDirectory = process.argv[3] ? resolve(process.argv[3]) : null;
const mime = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary'};
async function serve(directory) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); if (path.endsWith('/')) path += 'index.html';
    const file = resolve(directory, '.' + path);
    if (relative(directory, file).startsWith('..')) { res.writeHead(403).end(); return; }
    try { const body = await readFile(file); requests.push({path, bytes: body.length}); res.writeHead(200, {'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600'}).end(body); } catch { res.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {url: `http://127.0.0.1:${server.address().port}`, requests, stop: () => new Promise(done => server.close(done))};
}

function instrument() {
  const original = {setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame, cancelAnimationFrame, add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener, draw: CanvasRenderingContext2D.prototype.drawImage, bounds: Element.prototype.getBoundingClientRect, create: URL.createObjectURL, revoke: URL.revokeObjectURL};
  const timers = new Map(), intervals = new Map(), frames = new Map(), listeners = [], urls = new Set();
  const calls = {timeout: 0, interval: 0, raf: 0, draw: 0, sdkDraw: 0, bounds: 0, sdkBounds: 0};
  const owner = () => new Error().stack?.includes('/web/') ? 'sdk' : 'host';
  window.setTimeout = (callback, delay, ...args) => { const source = owner(); const id = original.setTimeout.call(window, () => { timers.delete(id); calls.timeout++; typeof callback === 'function' ? callback(...args) : (0, eval)(callback); }, delay); timers.set(id, {delay, source}); return id; };
  window.clearTimeout = id => { timers.delete(id); original.clearTimeout.call(window, id); };
  window.setInterval = (callback, delay, ...args) => { const id = original.setInterval.call(window, () => { calls.interval++; callback(...args); }, delay); intervals.set(id, delay); return id; };
  window.clearInterval = id => { intervals.delete(id); original.clearInterval.call(window, id); };
  window.requestAnimationFrame = callback => { const id = original.requestAnimationFrame.call(window, time => { frames.delete(id); calls.raf++; callback(time); }); frames.set(id, owner()); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); original.cancelAnimationFrame.call(window, id); };
  EventTarget.prototype.addEventListener = function(type, fn, options) {
    if (fn && (typeof fn === 'function' || typeof fn === 'object')) listeners.push({target: new WeakRef(this), fn: new WeakRef(fn), type, source: owner(), capture: !!(typeof options === 'boolean' ? options : options?.capture), signal: options?.signal ? new WeakRef(options.signal) : null, removed: false});
    return original.add.call(this, type, fn, options);
  };
  EventTarget.prototype.removeEventListener = function(type, fn, options) { const capture = !!(typeof options === 'boolean' ? options : options?.capture); for (const item of listeners) if (item.target.deref() === this && item.fn.deref() === fn && item.type === type && item.capture === capture) item.removed = true; return original.remove.call(this, type, fn, options); };
  CanvasRenderingContext2D.prototype.drawImage = function(...args) { calls.draw++; if (owner() === 'sdk') calls.sdkDraw++; return original.draw.apply(this, args); };
  Element.prototype.getBoundingClientRect = function() { calls.bounds++; if (owner() === 'sdk') calls.sdkBounds++; return original.bounds.call(this); };
  URL.createObjectURL = value => { const url = original.create.call(URL, value); urls.add(url); return url; };
  URL.revokeObjectURL = url => { urls.delete(url); return original.revoke.call(URL, url); };
  let hidden = false;
  const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
  window.resourceProbe = {
    hide(value) { hidden = value; Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden}); Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => hidden ? 'hidden' : 'visible'}); document.dispatchEvent(new Event('visibilitychange')); },
    reset() { for (const key of Object.keys(calls)) calls[key] = 0; },
    sample() { const live = listeners.filter(item => !item.removed && item.target.deref() && item.fn.deref() && !item.signal?.deref()?.aborted); return {nativeHidden: nativeHidden.call(document), syntheticHidden: hidden, calls: {...calls}, pendingTimeouts: [...timers.values()], intervals: intervals.size, raf: frames.size, objectURLs: urls.size, listeners: live.length, sdkListeners: live.filter(item => item.source === 'sdk').length, detachedElementListeners: live.filter(item => item.target.deref() instanceof Element && !item.target.deref().isConnected).length, widgetCount: document.querySelectorAll('[data-andromeda]').length}; },
  };
}

const desktop = await serve(root), site = siteDirectory ? await serve(siteDirectory) : null;
let browser;
const output = {label, method: 'Local Chromium, cold browser context per page, server payload bytes; synthetic document visibility exercises application hooks without browser background throttling. Counter probes add overhead: compare counts, not CPU wall time.', sdk: {}, site: {}};
try {
  browser = await chromium.launch({headless: true, executablePath: findChromium(), chromiumSandbox: true});
  async function pageAt(base, pathname) { const context = await browser.newContext({viewport: {width: 1280, height: 900}}); await context.addInitScript(instrument); const page = await context.newPage(), errors = [], warnings = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.type() === 'warning') warnings.push(message.text()); }); await page.goto(base + pathname); return {page, context, errors, warnings, cdp: await context.newCDPSession(page)}; }
  async function sample(page, cdp, wait = 1200) { await page.evaluate(() => resourceProbe.reset()); if (wait) await page.waitForTimeout(wait); await cdp.send('HeapProfiler.collectGarbage'); return page.evaluate(() => resourceProbe.sample()); }
  const {page, context, cdp} = await pageAt(desktop.url, '/web/demo.html');
  await page.evaluate(() => demoGuide.ready); await page.waitForTimeout(200);
  output.sdk.idle = await sample(page, cdp);
  await page.evaluate(() => resourceProbe.reset());
  await page.evaluate(() => { for (let i = 0; i < 200; i++) document.dispatchEvent(new PointerEvent('pointermove', {pointerType: 'mouse', clientX: 10 + i % 10, clientY: 20, bubbles: true})); });
  await cdp.send('HeapProfiler.collectGarbage');
  output.sdk.distantPointer = await page.evaluate(() => resourceProbe.sample());
  await page.evaluate(() => demoGuide.open()); await cdp.send('HeapProfiler.collectGarbage'); output.sdk.panelFirst = await page.evaluate(() => resourceProbe.sample());
  await page.evaluate(() => { for (let i = 0; i < 40; i++) demoGuide.open(); }); await cdp.send('HeapProfiler.collectGarbage'); output.sdk.panelRepeated = await page.evaluate(() => resourceProbe.sample());
  await page.evaluate(() => resourceProbe.hide(true)); output.sdk.hidden = await sample(page, cdp);
  await page.evaluate(() => { resourceProbe.hide(false); demoGuide.open(); const a = document.querySelector('[data-andromeda]').shadowRoot; a.querySelector('a[download]')?.remove(); });
  // Exercise an exported Blob URL, then immediately destroy before its delayed revoke.
  await page.evaluate(() => { const shadow = document.querySelector('[data-andromeda]').shadowRoot; shadow.addEventListener('click', event => { if (event.target.closest?.('a[download]')) event.preventDefault(); }, {capture: true}); [...shadow.querySelectorAll('button')].find(b => b.textContent === '导出偏好').click(); demoGuide.destroy(); });
  output.sdk.destroyed = await sample(page, cdp);
  output.sdk.afterDestroyCalls = await page.evaluate(() => {
    const preferences = demoGuide.exportPreferences(), storage = localStorage.getItem('andromeda.web.preferences.v1');
    demoGuide.open(); demoGuide.restore(); demoGuide.collapse();
    const played = demoGuide.play('greet'), said = demoGuide.say('销毁后不得恢复'), session = demoGuide.refreshSession();
    demoGuide.importPreferences({...preferences, preferences: {...preferences.preferences, sound: !preferences.preferences.sound}});
    return {unchanged: JSON.stringify(preferences) === JSON.stringify(demoGuide.exportPreferences()), storageUnchanged: storage === localStorage.getItem('andromeda.web.preferences.v1'), played, said, session};
  });
  await context.close();
  output.sdk.requests = {count: desktop.requests.length, bytes: desktop.requests.reduce((sum, item) => sum + item.bytes, 0), files: desktop.requests};
  await mkdir(resolve(root, 'qa'), {recursive: true}); await writeFile(resolve(root, `qa/web-resources-${label}.json`), JSON.stringify(output, null, 2) + '\n');
  if (site) {
    for (const [key, path] of [['home', '/'], ['character', '/tools/xingxuan/']]) {
      const start = site.requests.length; const current = await pageAt(site.url, path);
      console.log(`Measuring ${key}`);
      try { await current.page.locator('[data-andromeda] canvas[data-asset-state=ready]').waitFor({state: 'attached', timeout: 10000}); } catch (error) { console.log(JSON.stringify({path, errors: current.errors, widget: await current.page.locator('[data-andromeda]').count()})); throw error; }
      await current.page.waitForTimeout(2700);
      output.site[key] = {idle: await sample(current.page, current.cdp)};
      const demo = current.page.locator('[data-sprite-demo]').first();
      if (await demo.count()) { await demo.scrollIntoViewIfNeeded(); await current.page.waitForTimeout(200); output.site[key].showcase = await sample(current.page, current.cdp, 2200); await current.page.evaluate(() => resourceProbe.hide(true)); output.site[key].showcaseHidden = await sample(current.page, current.cdp, 2200); await current.page.evaluate(() => resourceProbe.hide(false)); }
      const viewer = current.page.locator('[data-model]').first();
      if (await viewer.count()) { await viewer.scrollIntoViewIfNeeded(); await current.page.locator('[data-model].is-ready').first().waitFor({timeout: 30000}).catch(() => {}); output.site[key].viewer = await sample(current.page, current.cdp); await current.page.emulateMedia({reducedMotion: 'reduce'}); output.site[key].viewerReduced = await sample(current.page, current.cdp); await current.page.evaluate(() => resourceProbe.hide(true)); output.site[key].viewerHidden = await sample(current.page, current.cdp); }
      await current.page.evaluate(() => { resourceProbe.hide(false); dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})); });
      output.site[key].bfcache = {widgets: await current.page.locator('[data-andromeda]').count(), viewers: await current.page.locator('[data-model] canvas').count()};
      await current.page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false})); dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false})); });
      output.site[key].destroyed = await sample(current.page, current.cdp);
      output.site[key].destroyedCanvases = await current.page.locator('[data-model] canvas,[data-sprite-demo] canvas').count();
      const files = site.requests.slice(start); output.site[key].requests = {count: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0), files};
      output.site[key].errors = current.errors;
      output.site[key].warnings = current.warnings;
      await current.context.close();
    }
  }
  await mkdir(resolve(root, 'qa'), {recursive: true}); await writeFile(resolve(root, `qa/web-resources-${label}.json`), JSON.stringify(output, null, 2) + '\n');
  if (label === 'after') {
    assert.equal(output.sdk.distantPointer.calls.sdkDraw, 0, 'Distant pointer must not redraw the neutral frame');
    assert.ok(output.sdk.distantPointer.calls.sdkBounds <= 1, 'Pointer events should reuse bounds until layout changes');
    assert.equal(output.sdk.panelRepeated.detachedElementListeners, 0);
    for (const sample of [output.sdk.hidden, output.sdk.destroyed]) {
      assert.equal(sample.calls.draw, 0); assert.equal(sample.calls.raf, 0); assert.equal(sample.pendingTimeouts.length, 0); assert.equal(sample.objectURLs, 0);
    }
    assert.deepEqual(output.sdk.afterDestroyCalls, {unchanged: true, storageUnchanged: true, played: false, said: false, session: null});
    for (const report of Object.values(output.site)) {
      for (const sample of [report.showcaseHidden, report.viewerHidden, report.destroyed]) {
        assert.equal(sample.calls.draw, 0); assert.equal(sample.calls.raf, 0); assert.equal(sample.pendingTimeouts.length, 0);
      }
      assert.ok(report.viewer.calls.raf <= 40, 'Visible 3D is capped below 30 fps');
      assert.ok(report.viewerReduced.calls.raf <= 1, 'Reduced-motion has no continuing rendering loop'); assert.equal(report.viewerReduced.raf, 0);
      assert.equal(report.bfcache.widgets, 1); assert.ok(report.bfcache.viewers >= 1);
      assert.equal(report.destroyed.widgetCount, 0); assert.equal(report.destroyedCanvases, 0);
      assert.equal(report.errors.filter(message => !message.includes('favicon.ico') && !message.includes('404 (Not Found)')).length, 0);
    }
    console.log('Resource/lifecycle regression assertions passed.');
  }
  console.log(`Saved qa/web-resources-${label}.json`);
} finally { if (browser) await browser.close(); await desktop.stop(); if (site) await site.stop(); }
