import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWebPreferences, exportWebPreferences, importWebPreferences, safeLink, acceptTaskEvent, placeWidget, avoidOverlapPlacement} from '../web/policy.mjs';
import {createSiteContent, searchSiteContent, pageContent, SITE_CONTENT} from '../src/shared/site-content.mjs';
import {studioCrop} from '../web/studio.mjs';
import {createCompanionEngine} from '../src/shared/companion.mjs';
import {prepareWebCharacter, sameOriginAsset, nearestLookCell} from '../web/character-loader.mjs';
import {createReadingProgress} from '../web/reading.mjs';

test('portable preferences strip position, accounts, tasks, secrets and prototype keys', () => {
  const data = JSON.parse('{"motion":"still","sound":true,"x":0.4,"dock":"left","userId":"owner","apiKey":"secret","memories":["private"],"__proto__":{"polluted":true}}');
  const exported = exportWebPreferences(data);
  assert.equal(exported.preferences.motion, 'still'); assert.equal(exported.preferences.sound, true);
  for (const key of ['x', 'dock', 'userId', 'apiKey', 'memories', '__proto__']) assert.equal(Object.hasOwn(exported.preferences, key), false);
  const imported = importWebPreferences(exported, {x: .8, dock: 'right', collapsed: true});
  assert.equal(imported.x, .8); assert.equal(imported.dock, 'right'); assert.equal(imported.collapsed, true);
  assert.equal({}.polluted, undefined); assert.throws(() => importWebPreferences({schema: 'unknown', preferences: {}}));
});
test('corrupt stored values never introduce invalid positions or accidental sound', () => {
  assert.deepEqual(normalizeWebPreferences(null), normalizeWebPreferences({}));
  const result = normalizeWebPreferences({motion: 'hyper', sound: 'true', x: Infinity, y: -5, collapsed: 1});
  assert.equal(result.motion, 'quiet'); assert.equal(result.sound, false); assert.equal(result.x, 1); assert.equal(result.y, 0); assert.equal(result.collapsed, false);
  for (const viewport of [{width: 390, height: 280}, {width: 60, height: 20}]) {
    const position = placeWidget({x: 500, y: -5}, viewport, {width: 128, height: 140});
    assert.ok(position.left >= 0 && position.top >= 0); assert.ok(Number.isFinite(position.left));
  }
});
test('private task notifications require a real host session with exactly matching user scope', () => {
  const event = {eventId: 'evt-1', taskId: 'task-1', userId: 'user-a', status: 'completed', text: 'done'};
  for (const session of [null, {}, {authenticated: false, userId: 'user-a'}, {authenticated: true, userId: 'user-b'}]) assert.equal(acceptTaskEvent(event, session), null);
  const command = acceptTaskEvent(event, {authenticated: true, userId: 'user-a'});
  assert.equal(command.type, 'task.event'); assert.equal(command.title, 'task-1'); assert.equal(Object.hasOwn(command, 'userId'), false);
  assert.equal(acceptTaskEvent({...event, taskId: '<script>'}, {authenticated: true, userId: 'user-a'}), null);
  assert.equal(acceptTaskEvent({...event, status: 'admin'}, {authenticated: true, userId: 'user-a'}), null);
});
test('navigation rejects executable URLs, credentials and nonlocal insecure HTTP', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,secret', 'file:///C:/private', 'https://owner:password@example.com', 'http://example.com']) assert.equal(safeLink(value), null);
  assert.equal(safeLink('/tools/xingxuan/'), 'https://starwright.xyz/tools/xingxuan/');
  assert.equal(safeLink('http://127.0.0.1:5180/'), 'http://127.0.0.1:5180/');
});
test('host tool catalog supplies current version and content to search and page guidance', () => {
  const content = createSiteContent({tools: [{id: 'modelwright', name: '模匠', href: '/tools/modelwright/', version: '9.8.7', summary: '最新说明', badges: ['3D']} ]});
  assert.match(pageContent('/tools/modelwright/', content).text, /9\.8\.7/);
  assert.match(searchSiteContent('9.8.7', content)[0].text, /最新说明/);
  assert.ok(searchSiteContent('下载').some(result => result.id === 'download'));
  assert.equal(searchSiteContent('unmatched-gibberish').length, 0);
  assert.ok(SITE_CONTENT.tools.every(tool => tool.href.startsWith('/tools/')));
});
test('web export imports directly into desktop core without leaking web-only state', () => {
  const engine = createCompanionEngine();
  const exported = exportWebPreferences({motion: 'still', visualStyle: 'studio', theme: 'dawn', gaze: false});
  const result = engine.dispatch({type: 'preferences.import', data: exported});
  assert.equal(result.state.preferences.visualStyle, 'studio'); assert.equal(result.state.preferences.theme, 'dawn');
  assert.equal(Object.hasOwn(exported.preferences, 'gaze'), false);
});
test('static studio poses preserve fractional source cells without claiming animation', () => {
  assert.deepEqual(studioCrop('greet').rect, [313.5, 0, 313.5, 418]);
  assert.deepEqual(studioCrop('point-right').rect, [940.5, 836, 313.5, 418]);
  assert.equal(studioCrop('unknown').index, 0); assert.equal(studioCrop('sleep').static, true);
});

const smallPack = () => ({schema: 'andromeda.character/v1', id: 'tiny-fixture', name: '测试角色', version: '1', source: {kind: 'original', author: 'Test', license: 'CC0', reference: 'generated fixture'},
  atlas: {image: 'images/atlas.png', width: 128, height: 80, cellWidth: 64, cellHeight: 80, columns: 2, rows: 1}, neutral: {row: 0, column: 1}, animations: {hello: {row: 0, frameCount: 2, durationsMs: [100, 200]}}, actions: {greet: 'hello'}});
test('web consumes validated arbitrary-size character packs and package-relative images', () => {
  const prepared = prepareWebCharacter(smallPack(), 'https://site.example/pets/tiny/character.json', 'https://site.example');
  assert.equal(prepared.pack.atlas.cellWidth, 64); assert.equal(prepared.manifest.neutral.column, 1);
  assert.equal(prepared.imageUrl.href, 'https://site.example/pets/tiny/images/atlas.png'); assert.equal(prepared.legacy, false);
  const invalid = smallPack(); invalid.atlas.width = 130; assert.throws(() => prepareWebCharacter(invalid, 'https://site.example/pets/a.json', 'https://site.example'));
});
test('package resources cannot escape to external origins or execute as URLs', () => {
  for (const image of ['https://evil.example/image.png', '//evil.example/a.png', '../a.png', '%2e%2e/a.png', '/a.png', 'data:image/png,secret', 'a.png?target=x', 'a.svg']) {
    const value = smallPack(); value.atlas.image = image; assert.throws(() => prepareWebCharacter(value, 'https://site.example/pets/a.json', 'https://site.example'));
  }
  for (const path of ['https://other.example/pack.json', 'https://u:p@site.example/pack.json', 'data:application/json,{}']) assert.throws(() => sameOriginAsset(path, 'https://site.example/', 'https://site.example'));
});
test('optional gaze supports arbitrary directions and column counts', () => {
  assert.equal(nearestLookCell(undefined, 2, 1, 0), null);
  const look = {rows: [2, 3], degreesClockwise: [0, 90, 180, 270]};
  assert.deepEqual(nearestLookCell(look, 2, -1, 0), {row: 3, column: 1});
  assert.deepEqual(nearestLookCell(look, 2, .01, -1), {row: 2, column: 0});
});
test('reading progress counts only the declared visible container with opt-in and caps suspended time', () => {
  const tracker = createReadingProgress({minimumVisibleMs: 2000});
  const update = patch => tracker.update({now: 0, top: 100, height: 500, viewportHeight: 800, enabled: true, visible: true, ...patch});
  assert.equal(update({enabled: false}).visibleMs, 0); assert.equal(update({now: 1000}).eligible, false);
  assert.equal(update({now: 2000}).visibleMs, 1000); assert.equal(update({now: 3000, visible: false}).visibleMs, 1000);
  assert.equal(update({now: 60000}).visibleMs, 1000); assert.equal(update({now: 61000}).eligible, true);
  const before = update({now: 62000, top: 900}); assert.equal(before.visibleMs, 2000);
  assert.equal(update({now: 100000, top: 900}).visibleMs, 2000);
});
test('explicit controls avoid saved positions temporarily and use compact fallback only when necessary', () => {
  const saved = {x: 1, y: 1}, viewport = {width: 390, height: 844}, expanded = {width: 96, height: 104}, compact = {width: 94, height: 46};
  const original = placeWidget(saved, viewport, expanded);
  const result = avoidOverlapPlacement(saved, viewport, expanded, compact, [{left: 240, top: 650, right: 390, bottom: 844}]);
  assert.equal(result.collapsed, false); assert.ok(result.point.left + expanded.width <= 232 || result.point.top + expanded.height <= 642);
  assert.deepEqual(saved, {x: 1, y: 1}); assert.deepEqual(avoidOverlapPlacement(saved, viewport, expanded, compact, []).point, original);
  const cramped = avoidOverlapPlacement(saved, viewport, expanded, compact, [{left: 0, right: 390, top: 60, bottom: 784}]);
  assert.equal(cramped.collapsed, true); assert.ok(cramped.point.top + compact.height <= 52 || cramped.point.top >= 792);
  assert.equal(avoidOverlapPlacement(saved, viewport, expanded, compact, [{left: 0, right: 390, top: 0, bottom: 844}], {forceExpanded: true}).collapsed, false);
});
