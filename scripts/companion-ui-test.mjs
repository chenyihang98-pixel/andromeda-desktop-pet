import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,relative,extname} from 'node:path';
import assert from 'node:assert/strict';
import {findChromium} from './ui-browser.mjs';
const root=resolve('.'),mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(relative(root,file).startsWith('..')){res.writeHead(403).end();return;}try{const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:findChromium(),headless:true,chromiumSandbox:true});
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
try {
  await mkdir('qa',{recursive:true});
  const page=await browser.newPage({viewport:{width:1080,height:780}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    let receive,engine,assistant={enabled:false,endpoint:'https://example.test/v1',model:'',asrModel:'',ttsModel:'',voice:'alloy',dailyRequestLimit:50,captureEnabled:false,toolsEnabled:false,status:{kind:'idle'},history:[],pendingTools:[],usage:{requests:0},hasApiKey:false,keyStorage:'none'};
    const ready=import('/src/shared/companion.mjs').then(({createCompanionEngine})=>{engine=createCompanionEngine();});
    window.calls=[];window.testBackup=async()=>{await ready;return{schema:'andromeda.backup/v1',companion:engine.serialize()};};
    window.andromeda={
      getState:async()=>({version:'0.3.0'}),onCompanion:fn=>{receive=fn;},
      companionState:async()=>{await ready;return{companion:engine.snapshot(),assistant};},
      command:async cmd=>{await ready;const result=engine.dispatch(cmd);receive({companion:result.state});return result;},
      showSettings:async()=>window.calls.push('settings'),openLink:async key=>window.calls.push(key),playAction:async action=>window.calls.push(action),
      exportData:async kind=>{window.calls.push('export-'+kind);return true;},exportCharacter:async()=>true,autostart:async enabled=>({enabled}),toss:async()=>true,
      restoreBackup:async({action,data})=>{const{validateCompanionBackup}=await import('/src/backup.mjs');const result=validateCompanionBackup(data);if(action==='restore'){const{createCompanionEngine}=await import('/src/shared/companion.mjs');engine=createCompanionEngine(result.state);receive({companion:engine.snapshot()});}return result.summary;},
      taskBridge:async enabled=>({enabled,running:enabled,port:12345,token:'test-only'}),
      assistant:async({method,payload})=>{
        if(method==='configure'){const{apiKey,...publicConfig}=payload;assistant={...assistant,...publicConfig,hasApiKey:!!apiKey};}
        if(method==='chat'){assistant.history.push({role:'user',content:payload.text});receive({assistantEvent:{type:'assistant:delta',text:'我们一起慢慢来。'}});assistant.history.push({role:'assistant',content:'我们一起慢慢来。'});}
        if(method==='clearHistory')assistant.history=[];
        if(method==='proposeTool')assistant.pendingTools.push({id:'card-1',name:payload.name,label:'待办操作',args:payload.args});
        if(method==='confirmTool'){if(payload.confirmed)await window.andromeda.command({type:'todo.add',text:assistant.pendingTools[0].args.text});assistant.pendingTools=[];}
        receive({assistant});return assistant;
      },
    };
  });
  await page.goto(base+'/src/companion.html');await page.locator('#hello').filter({hasText:'你好，你'}).waitFor();
  equal(await page.locator('[data-panel=today]').isVisible(),true);await page.locator('#star-game').click();equal(await page.locator('#catch-star').isVisible(),true);await page.screenshot({path:'qa/companion-today.png',fullPage:true});
  await page.locator('[data-tab=tasks]').click();await page.locator('#todo-text').fill('写完星璇的第一份计划');await page.locator('#todo-form button').click();
  equal(await page.locator('#todos .item').count(),1);
  await page.locator('#focus-minutes').fill('1');await page.locator('#focus-start').click();equal(await page.locator('#focus-label').textContent(),'一起专注中');equal(await page.locator('#catch-star').isHidden(),true);
  await page.locator('#focus-pause').click();equal(await page.locator('#focus-label').textContent(),'暂停了，回来再继续');
  await page.locator('#focus-resume').click();await page.locator('#focus-cancel').click();equal(await page.locator('#focus-label').textContent(),'已取消，随时重新开始');
  await page.locator('#todos button').filter({hasText:/^完成$/}).click();equal(await page.locator('#completed').textContent(),'1');
  await page.screenshot({path:'qa/companion-tasks.png',fullPage:true});
  await page.locator('[data-tab=memory]').click();await page.locator('#memory-text').fill('喜欢安静、简短的回答。');await page.locator('#memory-form button').click();
  equal(await page.locator('#memories .item').count(),1);await page.locator('#memories button').filter({hasText:'修改'}).click();await page.locator('#memories textarea').fill('重要事项请提醒一次。');await page.locator('#memories button').click();equal(await page.locator('#memories p').textContent(),'重要事项请提醒一次。');
  await page.locator('[data-tab=preferences]').click();await page.locator('#owner-name').fill('星匠');await page.locator('#profile-form button').click();equal(await page.locator('#hello').textContent(),'你好，星匠。');
  const backup=await page.evaluate(()=>window.testBackup());backup.companion.profile.ownerName='备份中的名字';await page.locator('#import-backup').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#restore-dialog').waitFor({state:'visible'});equal(await page.locator('#hello').textContent(),'你好，星匠。');await page.locator('#cancel-restore').click();equal(await page.locator('#hello').textContent(),'你好，星匠。');await page.locator('#import-backup').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#confirm-restore').click();await page.locator('#restore-dialog').waitFor({state:'hidden'});equal(await page.locator('#hello').textContent(),'你好，备份中的名字。');
  await page.locator('#ai-enabled').check();await page.locator('#ai-model').fill('mock-only');await page.locator('#ai-key').fill('not-a-real-key');await page.locator('#ai-tools').check();await page.locator('#assistant-config button').click();equal(await page.locator('#ai-key').inputValue(),'');
  await page.locator('[data-tab=chat]').click();await page.locator('#chat-text').fill('帮我想想今天怎么安排。');await page.locator('#chat-send').click();await page.locator('#chat-text').filter({visible:true}).waitFor();equal(await page.locator('#chat-history .message.assistant').last().textContent(),'我们一起慢慢来。');
  await page.locator('#tool-name').selectOption('addTodo');await page.locator('#tool-text').fill('操作卡新增待办');await page.locator('#tool-form button').click();equal(await page.locator('#tool-cards .item').count(),1);await page.locator('#tool-cards button').filter({hasText:'取消'}).click();equal(await page.locator('#tool-cards .item').count(),0);
  await page.locator('[data-tab=appearance]').click();await page.locator('#visual-style').selectOption('studio');await page.locator('#theme').selectOption('dawn');
  await page.locator('#open-editor').click();await page.getByRole('button',{name:'应用 JSON',exact:true}).click();assert.match(await page.locator('#editor-root [role=status]').textContent(),/通过/);checks++;await page.getByRole('button',{name:'导出角色包与所选图集',exact:true}).click();equal(await page.locator('#status').textContent(),'角色图片与动作已一起导出为 ZIP。');await page.locator('#close-editor').click();
  await page.screenshot({path:'qa/companion-appearance.png',fullPage:true});
  await page.setViewportSize({width:640,height:720});equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  equal(errors,[]);console.log(`Companion UI QA passed: ${checks} assertions. Screenshots in qa/companion-*.png. Assistant calls were mocked; no external request or recording.`);
} finally {await browser.close();await new Promise(r=>server.close(r));}
