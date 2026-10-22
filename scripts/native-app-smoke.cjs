'use strict';
// Run with the repository Electron executable. Uses a dedicated qa profile, never the owner's archive.
const {app,BrowserWindow,screen,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const qa=path.resolve(__dirname,'../qa');fs.mkdirSync(qa,{recursive:true});
let selectedCharacter=null;dialog.showOpenDialog=async()=>selectedCharacter?{canceled:false,filePaths:[selectedCharacter]}:{canceled:true,filePaths:[]};dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(qa,'native-export.character.zip')});
app.setPath('appData',path.join(qa,`native-profile-${process.pid}`));
const builtAsar=process.argv.includes('--asar');
const reportName=builtAsar?'native-asar-smoke.json':'native-app-smoke.json';
const result={scope:builtAsar?'built-asar-loaded-by-repository-electron':'actual-electron-app-on-current-windows-display',checks:[],limitations:['No real model/voice provider calls','No physical lock/suspend, mixed-DPI or monitor removal','No screenshot of other applications','Native file pickers are stubbed; archive persistence and renderer are real'],errors:[]};
const deadline=setTimeout(()=>{result.errors.push('probe timed out');finish(1);},45000);
function finish(code){clearTimeout(deadline);result.passed=code===0;fs.writeFileSync(path.join(qa,reportName),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,errors:result.errors,report:'qa/'+reportName}));app.exit(code);}
async function until(test){for(let i=0;i<150;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI readiness timed out');}
function check(condition,name){assert.ok(condition,name);result.checks.push(name);}
require(builtAsar?path.join(__dirname,'../dist/win-unpacked/resources/app.asar/src/main.cjs'):'../src/main.cjs');
app.whenReady().then(async()=>{
  try{
    result.displays=screen.getAllDisplays().map(({bounds,workArea,scaleFactor})=>({bounds,workArea,scaleFactor}));
    let pet;await until(()=>{pet=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html'));return pet&&!pet.webContents.isLoading();});
    await until(()=>pet.webContents.executeJavaScript("document.querySelector('#pet').dataset.row==='0'"));
    check(await pet.webContents.executeJavaScript("!performance.getEntriesByType('resource').some(item=>item.name.includes('/studio/'))"),'classic startup does not load optional Studio artwork');
    for(const scale of [.75,1,1.25,1.5,2]) {
      await pet.webContents.executeJavaScript('window.andromeda.setSettings('+JSON.stringify({scale})+')');
      check(await pet.webContents.executeJavaScript("(()=>{const r=document.querySelector('#pet').getBoundingClientRect();return Math.abs(r.width/r.height-12/13)<.001&&r.left>=-.1&&r.top>=-.1&&r.right<=innerWidth+.1&&r.bottom<=innerHeight+.1;})()"),`native canvas preserves ratio at ${scale*100}% pet scale on current display`);
    }
    await pet.webContents.executeJavaScript('window.andromeda.setSettings({scale:1.25})');
    check(await pet.webContents.executeJavaScript("window.andromeda.companionState().then(()=>false,()=>true)"),'pet renderer denied private state');
    await pet.webContents.executeJavaScript('window.andromeda.showCompanion()');
    let panel;await until(()=>{panel=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/companion.html'));return panel&&!panel.webContents.isLoading();});
    await until(()=>panel.webContents.executeJavaScript("document.querySelector('#hello').textContent.includes('你好，你')"));
    check((await panel.webContents.executeJavaScript('window.andromeda.companionState()')).companion.scope==='owner','private owner panel loads');
    check(await panel.webContents.executeJavaScript("document.querySelector('.hero-pet').complete&&document.querySelector('.hero-pet').naturalWidth>0"),'visible artwork loads over the local CSP protocol');
    await panel.webContents.executeJavaScript("window.andromeda.command({type:'todo.add',text:'原生运行验收提醒',dueAt:Date.now()})");
    await until(()=>pet.webContents.executeJavaScript("!document.querySelector('#bubble').hidden"));check(true,'passive semantic bubble reaches real pet renderer');
    await fs.promises.writeFile(path.join(qa,'native-companion.png'),(await panel.webContents.capturePage()).toPNG());
    await panel.webContents.executeJavaScript("window.andromeda.command({type:'preferences.update',patch:{visualStyle:'studio'}})");
    await until(()=>pet.webContents.executeJavaScript("!document.querySelector('#studio-pose').hidden"));
    await fs.promises.writeFile(path.join(qa,'native-studio-pet.png'),(await pet.webContents.capturePage()).toPNG());check(true,'studio pose reaches native transparent pet window');
    const state=await panel.webContents.executeJavaScript('window.andromeda.getState()');
    if(state.trayAvailable){await panel.webContents.executeJavaScript('window.andromeda.hide()');await panel.webContents.executeJavaScript("window.andromeda.command({type:'todo.add',text:'隐藏时只保存提醒',dueAt:Date.now()})");check(!pet.isVisible(),'due notification does not restore hidden pet');}
    await panel.webContents.executeJavaScript("window.andromeda.command({type:'focus.start',durationMinutes:1})");
    await panel.webContents.executeJavaScript("window.andromeda.command({type:'focus.pause'})");
    check((await panel.webContents.executeJavaScript('window.andromeda.companionState()')).companion.focus.status==='paused','focus pause persists through real IPC');
    check((await panel.webContents.executeJavaScript('window.andromeda.companionState()')).assistant.enabled===false,'AI remains disabled without configuration');
    await panel.webContents.executeJavaScript("document.querySelector('[data-tab=appearance]').click();document.querySelector('#open-editor').click()");
    check(await panel.webContents.executeJavaScript("Promise.all([...document.querySelectorAll('.sheet')].map(img=>{img.loading='eager';return img.decode();})).then(()=>true)"),'optional artwork decodes when explicitly requested');
    await until(()=>panel.webContents.executeJavaScript("!!document.querySelector('#editor-root canvas')&&document.querySelector('#editor-dialog').open"));
    check(await panel.webContents.executeJavaScript("document.querySelector('#editor-root [role=status]').textContent.includes('载入')"),'visual character editor loads native bundled atlas');
    await fs.promises.writeFile(path.join(qa,'native-editor.png'),(await panel.webContents.capturePage()).toPNG());
    const backup={schema:'andromeda.backup/v1',companion:(await panel.webContents.executeJavaScript('window.andromeda.companionState()')).companion};
    backup.companion.profile.ownerName='恢复验收';
    const preview=await panel.webContents.executeJavaScript('window.andromeda.restoreBackup('+JSON.stringify({action:'preview',data:backup})+')');
    check(preview.todos===2,'backup preview validates real native state');
    await panel.webContents.executeJavaScript('window.andromeda.restoreBackup('+JSON.stringify({action:'restore',data:backup})+')');
    check((await panel.webContents.executeJavaScript('window.andromeda.companionState()')).companion.profile.ownerName==='恢复验收','confirmed backup restores real native host');
    await panel.webContents.executeJavaScript("[...document.querySelectorAll('#editor-root button')].find(el=>el.textContent==='导出角色包与所选图集').click()");
    await until(()=>panel.webContents.executeJavaScript("document.querySelector('#status').textContent.includes('一起导出')"));
    const {readCharacterArchive,createCharacterArchive}=require('../src/services/character-archive.cjs');
    check((await readCharacterArchive(await fs.promises.readFile(path.join(qa,'native-export.character.zip')))).pack.id==='andromeda','native editor exports a readable complete ZIP');
    const {PNG}=require('pngjs'),png=new PNG({width:64,height:80});for(let i=0;i<png.data.length;i+=4){png.data[i]=40;png.data[i+1]=(i/4)%64<32?200:50;png.data[i+2]=80;png.data[i+3]=255;}
    const sample={schema:'andromeda.character/v1',id:'native-probe',name:'Native QA',version:'1',source:{kind:'original',author:'QA',license:'Test only',reference:'Synthetic fixture'},atlas:{image:'atlas.png',width:64,height:80,columns:2,rows:1,cellWidth:32,cellHeight:80},neutral:{row:0,column:0},animations:{idle:{row:0,frameCount:2,durationsMs:[200,200]}},actions:{idle:'idle'},lookDirections:{rows:[0],degreesClockwise:[0,90]},anchors:{ground:{x:.5,y:1}}};
    const packed=await createCharacterArchive({pack:sample,imageDataURL:'data:image/png;base64,'+PNG.sync.write(png).toString('base64')});selectedCharacter=path.join(qa,'native-fixture.character.zip');await fs.promises.writeFile(selectedCharacter,packed.archive);
    await panel.webContents.executeJavaScript("window.andromeda.installCharacter('import')");await until(()=>pet.webContents.executeJavaScript("document.body.dataset.customCharacter==='true'"));
    check(await pet.webContents.executeJavaScript("document.querySelector('#studio-pose').getContext('2d').getImageData(192,208,1,1).data[1]===200"),'arbitrary-size custom ZIP renders actual native pixels');
    await panel.webContents.executeJavaScript("window.andromeda.resetPosition();window.andromeda.setSettings({gaze:true,motion:'still'})");
    await until(()=>pet.webContents.executeJavaScript('!window.andromedaEnhancements.busy()'));
    await until(()=>pet.webContents.executeJavaScript("(()=>{const c=document.querySelector('#pet'),r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointermove',{clientX:r.right+100,clientY:r.top+r.height/2}));return document.querySelector('#studio-pose').getContext('2d').getImageData(192,208,1,1).data[1]===50;})()"));
    check(await pet.webContents.executeJavaScript("document.querySelector('#studio-pose').getContext('2d').getImageData(192,208,1,1).data[1]===50"),'custom gaze uses actual package direction frame');
    await pet.webContents.executeJavaScript("document.querySelector('#pet').dispatchEvent(new PointerEvent('pointerleave'))");
    check(await pet.webContents.executeJavaScript("document.querySelector('#studio-pose').getContext('2d').getImageData(192,208,1,1).data[1]===200"),'custom gaze resets after pointer leaves');
    await panel.webContents.executeJavaScript("window.andromeda.installCharacter('clear')");await until(()=>pet.webContents.executeJavaScript("document.body.dataset.customCharacter==='false'"));check(true,'custom character can return to builtin appearance');
    result.electron=process.versions.electron;result.platform=process.platform;
    app.emit('before-quit');finish(0);
  }catch(error){result.errors.push(error.message);app.emit('before-quit');finish(1);}
});
