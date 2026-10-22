import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {resolve,relative,extname,basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {findChromium} from './ui-browser.mjs';

const require=createRequire(import.meta.url),{createCompanionHost}=require('../src/companion-host.cjs');
const root=resolve('.'),mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(relative(root,file).startsWith('..')){res.writeHead(403).end();return;}
  try{const body=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'}).end(body);}
  catch{res.writeHead(404).end();}
});
await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
const directory=await fs.mkdtemp(join(tmpdir(),'andromeda-state-ui-'));
let browser,page,checks=0,releaseWrite=()=>{},releaseReply=()=>{},holdReply=null;
const equal=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const rename=fs.rename;
const host=createCompanionHost({directory,publish:value=>{if(page&&!page.isClosed())void page.evaluate(value=>window.receiveCompanion?.(value),value).catch(()=>{});},
  emit:()=>{},openLink:async()=>true});
try{
  await host.ready;
  browser=await chromium.launch({executablePath:findChromium(),headless:true,chromiumSandbox:true});
  page=await browser.newPage({viewport:{width:1080,height:780}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('nativeCommand',async command=>{
    const result=await host.dispatch(command);
    if(holdReply&&holdReply.text===command.text){const pending=holdReply;holdReply=null;pending.entered();await pending.gate;}
    return result;
  });
  await page.exposeFunction('nativeState',()=>host.state());
  await page.exposeFunction('nativeRestore',payload=>payload.action==='preview'?host.previewRestore(payload.data):host.restoreBackup({backup:payload.data,confirmed:true}));
  await page.addInitScript(()=>{
    window.andromeda={getState:async()=>({version:'state-test'}),onCompanion:fn=>{window.receiveCompanion=fn;return()=>{window.receiveCompanion=null;};},
      companionState:()=>window.nativeState(),command:command=>window.nativeCommand(command),restoreBackup:payload=>window.nativeRestore(payload)};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/companion.html`);
  await page.locator('#hello').filter({hasText:'你好，你'}).waitFor();

  // Real disk-backed host: a persona write waits while a later todo commits.
  let writeEntered;
  const writeGate=new Promise(done=>{releaseWrite=done;}),writeArrived=new Promise(done=>{writeEntered=done;});
  fs.rename=async(from,to)=>{if(basename(to)==='assistant.json'){writeEntered();await writeGate;}return rename(from,to);};
  await page.locator('[data-tab=preferences]').click();await page.locator('#persona').fill('保存人设时也可以安排待办');await page.locator('#profile-form button').click();await writeArrived;
  await page.locator('[data-tab=tasks]').click();await page.locator('#todo-text').fill('人设保存期间添加的待办');await page.locator('#todo-form button').click();await page.locator('#todos .item').waitFor();
  equal(await page.locator('#todos .item').count(),1);releaseWrite();
  await page.locator('#status').filter({hasText:'相处方式已保存'}).waitFor();
  equal(await page.locator('#todos .item').count(),1);equal((await host.state()).companion.todos.length,1);fs.rename=rename;

  // Delay only the transport reply after a real command has already published.
  // The response retains its old state, so this independently verifies the UI guard.
  let replyEntered;
  const replyGate=new Promise(done=>{releaseReply=done;}),replyArrived=new Promise(done=>{replyEntered=done;});
  holdReply={text:'较早提交的记忆',gate:replyGate,entered:replyEntered};
  await page.locator('[data-tab=memory]').click();await page.locator('#memory-text').fill('较早提交的记忆');await page.locator('#memory-form button').click();await replyArrived;
  await page.locator('#memory-text').fill('之后提交的记忆');await page.locator('#memory-form button').click();
  await page.waitForFunction(()=>document.querySelectorAll('#memories .item').length===2);
  equal(await page.locator('#memories .item').count(),2);releaseReply();
  await page.waitForFunction(()=>document.querySelector('#memory-text').value==='');
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  equal(await page.locator('#memories .item').count(),2);equal((await host.state()).companion.memories.length,2);

  // A whole-state restore invalidates drafts even when record IDs are reused.
  const backup=await host.exportData('backup');
  const memoryId=backup.companion.memories[0].id,todoId=backup.companion.todos[0].id;
  backup.companion.memories[0].text='备份恢复的记忆';backup.companion.todos[0].text='备份恢复的待办';
  await page.locator(`[data-entry-id="${memoryId}"]`).getByRole('button',{name:'修改',exact:true}).click();await page.locator('#memories textarea').fill('未保存的旧记忆草稿');
  await page.locator('[data-tab=tasks]').click();await page.locator(`[data-entry-id="${todoId}"]`).getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#todos textarea').fill('未保存的旧待办草稿');
  await page.locator('[data-tab=preferences]').click();
  const upload=()=>page.locator('#import-backup').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await upload();await page.locator('#restore-dialog').waitFor({state:'visible'});await page.locator('#cancel-restore').click();
  equal(await page.locator('#memories textarea').inputValue(),'未保存的旧记忆草稿');equal(await page.locator('#todos textarea').inputValue(),'未保存的旧待办草稿');
  await upload();await page.locator('#restore-dialog').waitFor({state:'visible'});await page.locator('#confirm-restore').click();await page.locator('#restore-dialog').waitFor({state:'hidden'});
  equal(await page.locator('#memories textarea').count(),0);equal(await page.locator('#todos textarea').count(),0);
  equal(await page.locator(`[data-entry-id="${memoryId}"] p`).textContent(),'备份恢复的记忆');
  equal(await page.locator(`[data-entry-id="${todoId}"] p`).textContent(),'备份恢复的待办');
  equal((await host.state()).companion.memories[0].text,'备份恢复的记忆');equal((await host.state()).companion.todos[0].text,'备份恢复的待办');
  await page.locator('[data-tab=memory]').click();await page.locator(`[data-entry-id="${memoryId}"]`).getByRole('button',{name:'修改',exact:true}).click();
  equal(await page.locator('#memories textarea').inputValue(),'备份恢复的记忆');
  await page.locator('#memories textarea').fill('恢复后的新编辑');await page.locator('#memories').getByRole('button',{name:'保存修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#memories textarea')===null);
  equal((await host.state()).companion.memories[0].text,'恢复后的新编辑');equal(errors,[]);
  console.log(`Companion state UI QA passed: ${checks} assertions. Real local host and disk; no model, microphone or external requests.`);
}finally{
  fs.rename=rename;releaseWrite();releaseReply();await host.stop();await browser?.close();await new Promise(done=>server.close(done));
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('andromeda-state-ui-'));
  await fs.rm(directory,{recursive:true,force:true});
}
