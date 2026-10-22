import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,extname} from 'node:path';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {findChromium} from './ui-browser.mjs';

// Browser raster/CSS checks complement native DIP geometry tests. These emulate
// screen configurations; they do not claim possession of multiple physical monitors.
const root=resolve('.'),mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(relative(root,file).startsWith('..')){res.writeHead(403).end();return;}
  try{const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:findChromium(),chromiumSandbox:true});
const screens=[[1280,720],[1366,768],[1920,1080],[2560,1440],[3840,2160],[3440,1440],[1080,1920]];
const report={scope:'Browser-emulated DPR and computed pet-window sizes; not physical multimonitor acceptance',rows:[],errors:[]};
const png=new PNG({width:32,height:80});for(let i=0;i<png.data.length;i+=4){png.data[i]=40;png.data[i+1]=200;png.data[i+2]=80;png.data[i+3]=255;}
const custom={imageDataURL:'data:image/png;base64,'+PNG.sync.write(png).toString('base64'),pack:{schema:'andromeda.character/v1',id:'ratio-qa',name:'Ratio QA',version:'1',source:{kind:'original',author:'QA',license:'Test',reference:'Synthetic solid rectangle'},atlas:{image:'atlas.png',width:32,height:80,columns:1,rows:1,cellWidth:32,cellHeight:80},neutral:{row:0,column:0},animations:{idle:{row:0,frameCount:1,durationsMs:[100]}},actions:{idle:'idle'}}};
try{
  await mkdir('qa',{recursive:true});
  for(const dpr of [1,1.25,1.5,2]){
    const context=await browser.newContext({viewport:{width:240,height:260},deviceScaleFactor:dpr});
    const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
    await page.addInitScript(()=>{
      window.appState={visible:true,settings:{motion:'still',gaze:false,globalGaze:false},companion:{preferences:{visualStyle:'classic',routine:false,reducedMotion:true},mood:0,level:1}};
      window.andromeda={getState:async()=>window.appState,onState:fn=>{window.updateState=fn;},onAction:()=>{},onPublic:fn=>{window.updatePublic=fn;},onCharacter:fn=>{window.updateCharacter=fn;},getCharacter:async()=>null};
      window.posePaint=null;const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='studio-pose'&&args.length===9)window.posePaint=args.slice(1);return draw.apply(this,args);};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/src/pet.html`);await page.waitForFunction(()=>typeof window.updateCharacter==='function');
    for(const style of ['classic','studio','custom']){
      await page.evaluate(({style,custom})=>{window.updateCharacter(style==='custom'?custom:null);window.appState.companion.preferences.visualStyle=style==='studio'?'studio':'classic';window.updateState(window.appState);},{style,custom});
      if(style!=='classic')await page.locator('#studio-pose').waitFor({state:'visible'});
      if(style==='custom')await page.waitForFunction(()=>document.body.dataset.customCharacter==='true');
      for(const [screenWidth,screenHeight] of screens)for(const petScale of [.75,1.25,2]){
        const availableWidth=Math.floor(screenWidth/dpr),availableHeight=Math.floor(screenHeight/dpr)-48;
        const factor=Math.min(petScale,availableWidth/192,availableHeight/208);
        const width=Math.floor(192*factor),height=Math.floor(208*factor);
        await page.setViewportSize({width,height});
        const value=await page.evaluate(style=>{
          const canvas=document.querySelector(style==='classic'?'#pet':'#studio-pose'),rect=canvas.getBoundingClientRect();
          const scaleX=rect.width/canvas.width,scaleY=rect.height/canvas.height;
          return{scaleX,scaleY,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,posePaint:window.posePaint,dpr:devicePixelRatio};
        },style);
        assert.ok(Math.abs(value.scaleX/value.scaleY-1)<.0002,`${style} CSS stretch at ${screenWidth}x${screenHeight}/${dpr}/${petScale}`);
        assert.ok(value.left>=-.1&&value.top>=-.1&&value.right<=width+.1&&value.bottom<=height+.1,`${style} canvas escapes window`);
        if(style==='studio'){
          const [, ,sw,sh,,,dw,dh]=value.posePaint;
          assert.ok(Math.abs((dw/dh)/(sw/sh)-1)<1e-10,'Studio source cropped with unequal scales');
        }
        if(style==='custom'){
          const bounds=await page.evaluate(()=>{const c=document.querySelector('#studio-pose'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let left=c.width,right=-1,top=c.height,bottom=-1;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(data[(y*c.width+x)*4+3]>128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}return{width:right-left+1,height:bottom-top+1};});
          assert.ok(Math.abs(bounds.width/bounds.height-32/80)<.005,'Custom opaque pixels stretched');
        }
        report.rows.push({screenWidth,screenHeight,dpr,petScale,style,window:{width,height},passed:true});
      }
      if(dpr===1.5){await page.setViewportSize({width:384,height:416});await page.screenshot({path:`qa/proportion-${style}.png`,omitBackground:true});}
    }
    // Deliberately non-proportional OS bounds exercise the CSS letterbox fallback.
    for(const [width,height] of [[384,312],[320,180],[150,260]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>{const r=document.querySelector('#studio-pose').getBoundingClientRect();return Math.abs(r.width/r.height-12/13)<.0002;}));}
    await context.close();
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
  console.log(`Desktop proportion matrix passed: ${report.rows.length} cases + 12 constrained-window checks.`);
}finally{await writeFile('qa/proportion-desktop.json',JSON.stringify(report,null,2));await browser.close();await new Promise(done=>server.close(done));}
