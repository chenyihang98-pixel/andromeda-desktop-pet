import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,relative} from 'node:path';
import assert from 'node:assert/strict';
import {findChromium} from './ui-browser.mjs';
const executablePath=findChromium();
const root=resolve('.');
const mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const filename=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(relative(root,filename).startsWith('..')){res.writeHead(403).end();return;}
  try{const body=await readFile(filename);res.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try { browser=await chromium.launch({headless:true,executablePath,chromiumSandbox:true}); }
catch (error) { await new Promise(r=>server.close(r)); throw error; }
await mkdir('qa',{recursive:true});
let checks=0;
const ok=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
async function setup(page){
  await page.addInitScript(()=>{
    Math.random=()=>0;
    window.calls=[];window.appState={settings:{scale:1.25,motion:'quiet',gaze:false,alwaysOnTop:true,edgeDock:true,globalGaze:false,clickThrough:false,autoHideFullscreen:false},visible:true,trayAvailable:true,fullscreenAvailable:true,fullscreenSuppressed:false,fullscreenError:null,persistenceError:null,version:'0.2.0',dock:null,clickThroughActive:false};
    window.andromeda={getState:async()=>window.appState,setSettings:async p=>{Object.assign(window.appState.settings,p);window.stateCallback?.(window.appState);return window.appState;},onState:fn=>{window.stateCallback=fn;},onAction:fn=>{window.actionCallback=fn;},onGaze:fn=>{window.gazeCallback=fn;},undock:async()=>{window.calls.push('undock');window.appState.dock=null;window.stateCallback?.(window.appState);return window.appState;},openReleases:async()=>window.calls.push('releases'),showSettings:()=>window.calls.push('settings'),hide:()=>window.calls.push('hide'),quit:()=>window.calls.push('quit'),resetPosition:()=>window.calls.push('reset'),playAction:a=>window.calls.push(a),startDrag:()=>window.calls.push('drag-start'),drag:()=>window.calls.push('drag'),endDrag:()=>window.calls.push('drag-end'),cancelDrag:()=>window.calls.push('drag-cancel')};
  });
}
async function emulateReducedMotion(page,reducedMotion){
  // emulateMedia updates the query before Chromium dispatches its change event.
  // Wait for that event so the renderer's earlier neutral() listener cannot
  // overwrite an action/gaze pose injected immediately after the transition.
  await page.evaluate(reduced=>{
    const query=matchMedia('(prefers-reduced-motion: reduce)');
    window.motionMediaChanged=query.matches===reduced?Promise.resolve():new Promise(resolve=>{
      query.addEventListener('change',()=>resolve(),{once:true});
    });
  },reducedMotion==='reduce');
  await page.emulateMedia({reducedMotion});
  await page.evaluate(async()=>{await window.motionMediaChanged;delete window.motionMediaChanged;});
}
try{
  const page=await browser.newPage({viewport:{width:240,height:260},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
  await page.clock.install();
  await page.goto(base+'/src/pet.html');await page.locator('#pet[data-row="0"]').waitFor();
  ok(await page.locator('#error').isHidden(),true);ok(await page.locator('#pet').getAttribute('data-column'),'0');
  const pixels=await page.evaluate(()=>{const d=document.querySelector('canvas').getContext('2d').getImageData(0,0,192,208).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});assert.ok(pixels>1000&&pixels<192*208);checks++;
  await page.screenshot({path:'qa/pet-neutral.png',omitBackground:true});
  await page.clock.runFor(44000);ok(await page.locator('#pet').getAttribute('data-column'),'0');
  await page.evaluate(()=>window.actionCallback('wave'));ok(await page.locator('#pet').getAttribute('data-row'),'3');
  await page.clock.runFor(220);ok(await page.locator('#pet').getAttribute('data-column'),'1');
  await page.screenshot({path:'qa/pet-wave.png',omitBackground:true});
  await page.clock.runFor(1200);ok(await page.locator('#pet').getAttribute('data-row'),'0');
  await page.locator('#pet').dblclick({position:{x:120,y:130}});ok((await page.evaluate(()=>window.calls)).includes('settings'),true);
  await page.mouse.move(120,130);await page.mouse.down();await page.mouse.move(130,140);await page.mouse.up();
  const calls=await page.evaluate(()=>window.calls);for(const name of ['drag-start','drag','drag-end'])ok(calls.includes(name),true);
  await page.evaluate(()=>window.andromeda.setSettings({gaze:true}));await page.mouse.move(230,130);
  ok(await page.locator('#pet').getAttribute('data-row'),'9');ok(await page.locator('#pet').getAttribute('data-column'),'4');
  await page.evaluate(()=>window.andromeda.setSettings({gaze:false,motion:'still'}));await page.clock.runFor(120000);
  ok(await page.locator('#pet').getAttribute('data-row'),'0');ok(await page.locator('#pet').getAttribute('data-column'),'0');
  await emulateReducedMotion(page,'reduce');await page.evaluate(()=>window.actionCallback('jump'));ok(await page.locator('#pet').getAttribute('data-row'),'4');
  await page.clock.runFor(950);ok(await page.locator('#pet').getAttribute('data-row'),'0');ok(errors,[]);
  await emulateReducedMotion(page,'no-preference');
  await page.evaluate(()=>window.andromeda.setSettings({globalGaze:true,motion:'quiet',gaze:true}));
  await page.evaluate(()=>window.gazeCallback({x:100,y:0}));
  ok(await page.locator('#pet').getAttribute('data-row'),'9');ok(await page.locator('#pet').getAttribute('data-column'),'4');
  await page.mouse.move(120,5);ok(await page.locator('#pet').getAttribute('data-column'),'4');
  await page.clock.runFor(120000);ok(await page.locator('#pet').getAttribute('data-row'),'9');
  await page.evaluate(()=>window.actionCallback('wave'));await page.clock.runFor(210);
  await page.evaluate(()=>{window.appState.persistenceError='disk full';window.stateCallback(window.appState);window.gazeCallback({x:-100,y:0});});
  ok(await page.locator('#pet').getAttribute('data-row'),'3');ok(await page.locator('#pet').getAttribute('data-column'),'1');
  await page.clock.runFor(840);await page.evaluate(()=>window.gazeCallback({x:-100,y:0}));
  ok(await page.locator('#pet').getAttribute('data-row'),'10');
  await page.evaluate(()=>{window.appState.dock={edge:'left',collapsed:true};window.stateCallback(window.appState);});
  await page.setViewportSize({width:14,height:64});
  ok(await page.locator('#pet').isHidden(),true);ok(await page.locator('#settings-button').isHidden(),true);ok(await page.locator('#dock-handle').isVisible(),true);
  await page.screenshot({path:'qa/dock-left.png',omitBackground:true});
  await page.locator('#dock-handle').press('Enter');ok(await page.evaluate(()=>window.calls.filter(x=>x==='undock').length),1);
  await page.evaluate(()=>{window.appState.dock={edge:'top',collapsed:true};window.stateCallback(window.appState);});
  await page.setViewportSize({width:64,height:14});await page.screenshot({path:'qa/dock-top.png',omitBackground:true});
  await page.locator('#dock-handle').click();ok(await page.evaluate(()=>window.calls.filter(x=>x==='undock').length),2);
  await page.setViewportSize({width:240,height:260});
  await page.evaluate(()=>{window.appState.dock={edge:'right',collapsed:false};window.stateCallback(window.appState);});
  ok(await page.locator('#dock-indicator').isVisible(),true);
  await page.keyboard.press('Escape');ok(await page.evaluate(()=>window.calls.filter(x=>x==='undock').length),3);
  ok(await page.locator('#dock-indicator').isHidden(),true);
  const settings=await browser.newPage({viewport:{width:480,height:740}});await setup(settings);settings.on('pageerror',e=>errors.push(e.message));
  await settings.goto(base+'/src/settings.html');await settings.locator('[data-motion="quiet"][aria-pressed="true"]').waitFor();
  await settings.screenshot({path:'qa/settings.png',fullPage:true});
  await settings.locator('[data-motion="still"]').click();ok(await settings.evaluate(()=>window.appState.settings.motion),'still');
  await settings.locator('#gaze').check();ok(await settings.evaluate(()=>window.appState.settings.gaze),true);
  await settings.locator('#globalGaze').check();ok(await settings.evaluate(()=>window.appState.settings.globalGaze),true);
  await settings.locator('#edgeDock').uncheck();ok(await settings.evaluate(()=>window.appState.settings.edgeDock),false);
  ok(await settings.locator('#autoHideFullscreen').isChecked(),false);
  await settings.locator('#autoHideFullscreen').check();ok(await settings.evaluate(()=>window.appState.settings.autoHideFullscreen),true);
  await settings.evaluate(()=>{window.appState.fullscreenSuppressed=true;window.stateCallback(window.appState);});
  ok((await settings.locator('#desktop-state').textContent()).includes('全屏中'),true);
  await settings.evaluate(()=>{window.appState.fullscreenSuppressed=false;window.appState.fullscreenError='检测失败，已关闭自动隐藏';window.stateCallback(window.appState);});
  ok((await settings.locator('#fullscreen-help').textContent()).includes('检测失败'),true);
  await settings.evaluate(()=>{window.appState.fullscreenAvailable=false;window.stateCallback(window.appState);});
  ok(await settings.locator('#autoHideFullscreen').isDisabled(),true);
  await settings.evaluate(()=>{window.appState.fullscreenAvailable=true;window.appState.fullscreenError=null;window.stateCallback(window.appState);});
  ok(await settings.locator('#autoHideFullscreen').isEnabled(),true);
  await settings.locator('#clickThrough').check();ok(await settings.evaluate(()=>window.appState.settings.clickThrough),true);
  ok((await settings.locator('#click-through-help').textContent()).includes('关闭穿透并解除停靠'),true);
  await settings.locator('#releases').click();ok((await settings.evaluate(()=>window.calls)).includes('releases'),true);
  ok((await settings.locator('#status').textContent()).includes('手动查看'),true);
  await settings.locator('#alwaysOnTop').uncheck();ok(await settings.evaluate(()=>window.appState.settings.alwaysOnTop),false);
  await settings.locator('#scale').fill('2');await settings.locator('#scale').dispatchEvent('change');ok(await settings.evaluate(()=>window.appState.settings.scale),2);ok(await settings.locator('#scale-value').textContent(),'200%');
  for(const action of ['wave','jump','wait','review']){await settings.locator(`[data-action="${action}"]`).click();ok((await settings.evaluate(()=>window.calls)).includes(action),true);}
  for(const action of ['reset','hide','quit']){await settings.locator('#'+action).click();ok((await settings.evaluate(()=>window.calls)).includes(action),true);}
  await settings.evaluate(()=>{window.appState.trayAvailable=false;window.appState.persistenceError='failed';window.stateCallback(window.appState);});ok(await settings.locator('#hide').isDisabled(),true);ok(await settings.locator('#clickThrough').isDisabled(),true);ok((await settings.locator('#status').textContent()).includes('无法保存'),true);
  ok(await settings.locator('#autoHideFullscreen').isDisabled(),true);
  await settings.evaluate(()=>{window.andromeda.openReleases=async()=>{throw new Error('simulated release failure');};});
  await settings.locator('#releases').click();ok((await settings.locator('#status').textContent()).includes('未能完成'),true);ok(await settings.locator('#releases').isEnabled(),true);
  await settings.setViewportSize({width:350,height:740});
  ok(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  ok(errors,[]);
  console.log(`Browser renderer QA passed: ${checks} assertions. Screenshots: qa/pet-neutral.png, qa/pet-wave.png, qa/settings.png, qa/dock-left.png, qa/dock-top.png`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
