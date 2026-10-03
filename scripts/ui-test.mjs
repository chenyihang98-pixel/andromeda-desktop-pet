import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,relative} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.');
const mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const filename=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(relative(root,filename).startsWith('..')){res.writeHead(403).end();return;}
  try{const body=await readFile(filename);res.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try { browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']}); }
catch (error) { await new Promise(r=>server.close(r)); throw error; }
await mkdir('qa',{recursive:true});
let checks=0;
const ok=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
async function setup(page){
  await page.addInitScript(()=>{
    Math.random=()=>0;
    window.calls=[];window.appState={settings:{scale:1.25,motion:'quiet',gaze:false,alwaysOnTop:true},visible:true,trayAvailable:true,persistenceError:null};
    window.andromeda={getState:async()=>window.appState,setSettings:async p=>{Object.assign(window.appState.settings,p);window.stateCallback?.(window.appState);return window.appState;},onState:fn=>{window.stateCallback=fn;},onAction:fn=>{window.actionCallback=fn;},showSettings:()=>window.calls.push('settings'),hide:()=>window.calls.push('hide'),quit:()=>window.calls.push('quit'),resetPosition:()=>window.calls.push('reset'),playAction:a=>window.calls.push(a),startDrag:()=>window.calls.push('drag-start'),drag:()=>window.calls.push('drag'),endDrag:()=>window.calls.push('drag-end')};
  });
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
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>window.actionCallback('jump'));ok(await page.locator('#pet').getAttribute('data-row'),'4');
  await page.clock.runFor(950);ok(await page.locator('#pet').getAttribute('data-row'),'0');ok(errors,[]);
  const settings=await browser.newPage({viewport:{width:480,height:740}});await setup(settings);settings.on('pageerror',e=>errors.push(e.message));
  await settings.goto(base+'/src/settings.html');await settings.locator('[data-motion="quiet"][aria-pressed="true"]').waitFor();
  await settings.screenshot({path:'qa/settings.png',fullPage:true});
  await settings.locator('[data-motion="still"]').click();ok(await settings.evaluate(()=>window.appState.settings.motion),'still');
  await settings.locator('#gaze').check();ok(await settings.evaluate(()=>window.appState.settings.gaze),true);
  await settings.locator('#alwaysOnTop').uncheck();ok(await settings.evaluate(()=>window.appState.settings.alwaysOnTop),false);
  await settings.locator('#scale').fill('2');await settings.locator('#scale').dispatchEvent('change');ok(await settings.evaluate(()=>window.appState.settings.scale),2);ok(await settings.locator('#scale-value').textContent(),'200%');
  for(const action of ['wave','jump','wait','review']){await settings.locator(`[data-action="${action}"]`).click();ok((await settings.evaluate(()=>window.calls)).includes(action),true);}
  for(const action of ['reset','hide','quit']){await settings.locator('#'+action).click();ok((await settings.evaluate(()=>window.calls)).includes(action),true);}
  await settings.evaluate(()=>{window.appState.trayAvailable=false;window.appState.persistenceError='failed';window.stateCallback(window.appState);});ok(await settings.locator('#hide').isDisabled(),true);ok((await settings.locator('#status').textContent()).includes('无法保存'),true);
  ok(errors,[]);
  console.log(`Browser renderer QA passed: ${checks} assertions. Screenshots: qa/pet-neutral.png, qa/pet-wave.png, qa/settings.png`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
