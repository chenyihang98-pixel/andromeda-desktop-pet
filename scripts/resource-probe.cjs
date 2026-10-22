'use strict';
// Reproducible local profiling: isolated profile, bundled app, no network or owner data.
const {app, BrowserWindow, screen} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {performance} = require('node:perf_hooks');
const qa = path.resolve(__dirname, '../qa');
fs.mkdirSync(qa, {recursive: true});
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'current';
if (!/^[a-z0-9-]{1,60}$/.test(label)) throw new Error('Invalid report label');
const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.slice(10) || 20);
const actionsOnly = process.argv.includes('--actions'), builtAsar = process.argv.includes('--asar');
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('Use 5–60 seconds per scenario');
app.setPath('appData', path.join(qa, `resource-profile-${process.pid}`));
let writes = 0;
const rename = fs.renameSync;
fs.renameSync = function(from, to) {if (path.basename(String(to)) === 'companion-v1.json') writes++;return rename.apply(this, arguments);};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {label, source: builtAsar ? 'built-asar' : 'working-tree', electron: process.versions.electron, node: process.versions.node, platform: process.platform,
  logicalProcessors: os.cpus().length, secondsPerScenario: seconds, scenarios: [],
  method: 'Sum Electron process cumulative CPU deltas / wall time (one core = 100%); private bytes and working set are process sums. No forced GC. Instrumented draw/DOM/IPC counts. Dedicated clean profile; gaze/motion disabled for idle reproducibility.',
  limitations: ['Single Windows host, short samples, memory/CPU vary with OS and GC', 'Working sets include shared pages; private memory is the better process-total comparison', 'Windows does not report idle wakeups; no claim of measured OS wakeup count', 'No AI/voice provider or remote network, multimonitor or physical suspend tests']};
const deadline = setTimeout(() => finish(new Error('Resource probe timed out')), 240000);
function finish(error) {
  clearTimeout(deadline);report.error = error?.stack || null;
  fs.writeFileSync(path.join(qa, `resources-${label}.json`), JSON.stringify(report, null, 2));
  app.emit('before-quit');console.log(JSON.stringify({report: `qa/resources-${label}.json`, error: error?.message || null}));app.exit(error ? 1 : 0);
}
async function until(test) {for (let n = 0; n < 150; n++) {const value = await test();if (value) return value;await wait(100);}throw new Error('Renderer readiness timed out');}
const ipc = new Map();
async function instrument(window) {
  if (ipc.has(window.id)) return;
  ipc.set(window.id, {});const send = window.webContents.send;
  window.webContents.send = function(channel, ...args) {const counts = ipc.get(window.id);counts[channel] = (counts[channel] || 0) + 1;return send.call(this, channel, ...args);};
  await window.webContents.executeJavaScript(`(() => {
    const stats = window.__resourceProbe = {draws: 0, mutations: 0};
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) {stats.draws++;return draw.apply(this, args);};
    new MutationObserver(records => {stats.mutations += records.length;}).observe(document.body, {attributes:true, childList:true, subtree:true, characterData:true});
  })()`);
}
async function sample(name, exercise) {
  await wait(2000);
  const windows = BrowserWindow.getAllWindows();
  // Ignore pointer interaction only in these owned, disposable QA windows so
  // an incidental click cannot be mistaken for idle work in the report.
  for (const window of windows) {window.setIgnoreMouseEvents(true);await instrument(window);ipc.set(window.id, {});await window.webContents.executeJavaScript('Object.assign(window.__resourceProbe,{draws:0,mutations:0});void 0');}
  const before = app.getAppMetrics(), writesBefore = writes, started = performance.now();
  const stopExercise = exercise?.();
  await wait(seconds * 1000);
  stopExercise?.();
  const elapsed = (performance.now() - started) / 1000, after = app.getAppMetrics();
  const cpuSeconds = after.reduce((sum, item) => {
    const previous = before.find(value => value.pid === item.pid);
    return sum + (previous && item.cpu.cumulativeCPUUsage !== undefined ? Math.max(0, item.cpu.cumulativeCPUUsage - previous.cpu.cumulativeCPUUsage) : 0);
  }, 0);
  const renderer = [];
  for (const window of windows) renderer.push({page: path.basename(window.webContents.getURL()), visible: window.isVisible(),
    ipc: ipc.get(window.id), ...await window.webContents.executeJavaScript(`({ ...window.__resourceProbe,
      resources: performance.getEntriesByType('resource').filter(item => /studio|andromeda.png/.test(item.name)).map(item => ({name: item.name.split('/').pop(),encodedBodySize:item.encodedBodySize})),
      domNodes: document.getElementsByTagName('*').length, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null })`)});
  const value = {name, elapsedSeconds: elapsed, cpuSeconds, cpuOneCorePercent: cpuSeconds / elapsed * 100,
    privateMiB: after.reduce((sum,item)=>sum+(item.memory.privateBytes || 0),0)/1024,
    workingSetMiB: after.reduce((sum,item)=>sum+item.memory.workingSetSize,0)/1024,
    processes: after.map(item => ({type:item.type,privateMiB:(item.memory.privateBytes || 0)/1024})),
    companionWrites: writes-writesBefore, renderer,
    unexpectedIdleActivity: !exercise && !name.includes('roam') && renderer.some(item=>(item.ipc['andromeda:event']||0)>0||(item.ipc['andromeda:action']||0)>0)};
  report.scenarios.push(value);console.log(JSON.stringify({scenario:name,cpuPercent:value.cpuOneCorePercent,privateMiB:value.privateMiB,writes:value.companionWrites,renderer:renderer.map(({page,draws,mutations,ipc})=>({page,draws,mutations,ipc}))}));
}
require(builtAsar ? path.join(__dirname, '../dist/win-unpacked/resources/app.asar/src/main.cjs') : '../src/main.cjs');
app.whenReady().then(async () => {
  try {
    report.displays = screen.getAllDisplays().map(({workArea,scaleFactor})=>({workArea,scaleFactor}));
    const pet = await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/pet.html')&&!window.webContents.isLoading()));
    await until(()=>pet.webContents.executeJavaScript("document.querySelector('#pet').dataset.row==='0'"));
    await pet.webContents.executeJavaScript("window.andromeda.setSettings({motion:'still',gaze:false,globalGaze:false})");
    if (actionsOnly) {
      await pet.webContents.executeJavaScript('window.andromeda.showCompanion()');
      let panel = await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/companion.html')&&!window.webContents.isLoading()));
      const backup = {schema:'andromeda.backup/v1',companion:(await panel.webContents.executeJavaScript('window.andromeda.companionState()')).companion};
      const at=Date.now();
      backup.companion.memories=Array.from({length:160},(_,index)=>({id:'memory-'+index,text:'测试'.repeat(900),source:'user',createdAt:at,updatedAt:at}));
      backup.companion.todos=Array.from({length:180},(_,index)=>({id:'todo-'+index,text:'测试'.repeat(240),dueAt:null,status:'open',createdAt:at,updatedAt:at,completedAt:null,remindedAt:null,rewarded:false}));
      backup.companion.tasks=Array.from({length:80},(_,index)=>({id:'task-'+index,title:'QA',text:'测试'.repeat(240),status:'completed',updatedAt:at}));
      report.syntheticArchiveBytes=Buffer.byteLength(JSON.stringify(backup));
      await panel.webContents.executeJavaScript('window.andromeda.restoreBackup('+JSON.stringify({action:'restore',data:backup})+')');panel.close();
      await sample('large-archive-greeting',()=>{const timer=setInterval(()=>void pet.webContents.executeJavaScript("window.andromeda.playAction('wave')").catch(()=>{}),2500);return()=>clearInterval(timer);});
      await pet.webContents.executeJavaScript('window.andromeda.showCompanion()');
      panel=await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/companion.html')&&!window.webContents.isLoading()));
      await panel.webContents.executeJavaScript("window.andromeda.command({type:'preferences.update',patch:{movement:'roam'}})");panel.close();
      await sample('large-archive-roam');finish();return;
    }
    await sample('classic-idle');
    await pet.webContents.executeJavaScript('window.andromeda.showCompanion()');
    const panel = await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/companion.html')&&!window.webContents.isLoading()));
    await until(()=>panel.webContents.executeJavaScript("document.querySelector('#hello').textContent.includes('你好，你')"));
    await sample('panel-idle');
    await panel.webContents.executeJavaScript("window.andromeda.command({type:'preferences.update',patch:{visualStyle:'studio'}})");
    panel.close();
    await sample('studio-idle');
    await pet.webContents.executeJavaScript('window.andromeda.showCompanion()');
    const focusPanel = await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/companion.html')&&!window.webContents.isLoading()));
    await focusPanel.webContents.executeJavaScript("window.andromeda.command({type:'focus.start',durationMinutes:25})");
    await sample('focus-panel');
    await focusPanel.webContents.executeJavaScript("window.andromeda.command({type:'focus.pause'})");
    focusPanel.close();await pet.webContents.executeJavaScript('window.andromeda.hide()');
    await sample('hidden');finish();
  } catch (error) {finish(error);}
});
