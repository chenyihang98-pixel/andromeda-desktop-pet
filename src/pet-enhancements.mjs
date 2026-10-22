import {createBehaviorScheduler} from './shared/behavior.mjs';
import {characterPackFromAtlas, createActionResolver} from './shared/character.mjs';
import {createCustomCharacter} from './custom-character.mjs';
import {containRect} from './animation.mjs';
const api = window.andromeda, bubble = document.querySelector('#bubble'), panelButton = document.querySelector('#companion-button');
const pose = document.querySelector('#studio-pose'), poseContext = pose.getContext('2d'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
const scheduler = createBehaviorScheduler();
const studio = new Image();
let studioRequested = false, studioFrame = null;
let connected, resolve, timer, activeId, currentAction = 'idle', publicState, pointer, lastInteraction = 0;
let custom=null,customGeneration=0,customAction=null,surfacePaused=false,hostPaused=false;
const poseIndex = {idle:0,greet:1,happy:2,think:3,read:4,question:5,notify:5,stretch:6,sleep:7,pet:8,drag:9,'point-left':10,'point-right':11};
const basePose=()=>publicState?.focusing?'read':publicState?.preferences?.routine&&publicState?.routine?.period==='night'?'sleep':publicState?.mood>=15?'happy':'idle';
function displayPose(action,force=false) {
  currentAction = action;
  if(custom){studioFrame=null;if(pose.hidden)pose.hidden=false;document.body.classList.add('studio-mode');if(document.body.dataset.customCharacter!=='true')document.body.dataset.customCharacter='true';if(!surfacePaused&&(force||customAction!==action)){customAction=action;custom.draw(action);}return;}
  if(document.body.dataset.customCharacter!=='false')document.body.dataset.customCharacter='false';
  if(publicState?.preferences?.visualStyle==='studio'&&!studioRequested&&!surfacePaused){studioRequested=true;studio.src='../assets/studio/life-poses-v1.png';}
  const enabled = publicState?.preferences?.visualStyle === 'studio' && studio.complete && studio.naturalWidth > 0;
  if(pose.hidden===enabled)pose.hidden=!enabled;
  if(document.body.classList.contains('studio-mode')!==enabled)document.body.classList.toggle('studio-mode',enabled);
  if (!enabled || surfacePaused) return;
  const index = poseIndex[action] ?? 0, width = studio.naturalWidth / 4, height = studio.naturalHeight / 3;
  if(studioFrame===index)return;
  const target=containRect(width,height,pose.width,pose.height);
  poseContext.clearRect(0,0,384,416);
  poseContext.drawImage(studio,(index%4)*width,Math.floor(index/4)*height,width,height,target.x,target.y,target.width,target.height);
  studioFrame=index;
}
async function applyCustom(value){
  const token=++customGeneration;custom?.destroy();custom=null;customAction=null;studioFrame=null;
  if(!value){displayPose(currentAction,true);return;}
  try{const candidate=createCustomCharacter({canvas:pose,...value,reducedMotion:reduced.matches||!!publicState?.preferences?.reducedMotion});custom=candidate;
    if(!await candidate.ready||token!==customGeneration)return;displayPose(currentAction,true);
  }catch{if(token===customGeneration){custom?.destroy();custom=null;displayPose(currentAction,true);bubble.textContent='自定义角色未能显示，已恢复内置外观。';bubble.hidden=false;}}
}
studio.addEventListener('load',()=>displayPose(currentAction));
function refresh() {
  clearTimeout(timer);
  const state = scheduler.tick(), active = state.active, wasPaused=surfacePaused;
  surfacePaused=state.paused;
  if (state.paused) {bubble.hidden = true;activeId = null;custom?.stop();customAction=null;document.body.style.setProperty('--rhythm-y','0px');return;}
  if (active && active.id !== activeId && connected) {
    activeId = active.id; displayPose(active.action,true); if(!custom&&pose.hidden)connected.play(resolve(active.action,{reducedMotion:reduced.matches||!!publicState?.preferences?.reducedMotion}).animation);
    bubble.textContent = active.text; bubble.hidden = !active.text;
  } else if (!active && activeId) {activeId = null;bubble.hidden = true;displayPose(basePose());connected?.neutral();}
  else if(wasPaused&&!active)displayPose(basePose(),true);
  const delay=scheduler.nextDelay();if(delay!==null)timer=setTimeout(refresh,delay);
}
function updatePublic(state) { if (!state) return;
  const motionChanged=!!publicState?.preferences?.reducedMotion!==!!state.preferences?.reducedMotion;
  const styleChanged=publicState?.preferences?.visualStyle!==state.preferences?.visualStyle;
  publicState = state;const theme=state.preferences?.theme||'night';if(document.body.dataset.theme!==theme)document.body.dataset.theme=theme;displayPose(activeId||pointer?currentAction:basePose());
  if(styleChanged&&activeId&&!custom&&pose.hidden&&!surfacePaused)connected?.play(resolve(currentAction,{reducedMotion:reduced.matches||!!state.preferences?.reducedMotion}).animation);
  custom?.setReducedMotion(reduced.matches||!!state.preferences?.reducedMotion);
  if(motionChanged){scheduler.setContext({reducedMotion:reduced.matches||!!state.preferences?.reducedMotion});connected?.neutral();refresh();}
  if(state.focusing||state.preferences?.reducedMotion)document.body.style.setProperty('--rhythm-y','0px');
  const adornment=document.querySelector('#growth-adornment'),hidden=!(state.level>=2),text=state.level>=3?'✦ · ✧ · ✦':'✦',title=state.level>=3?'陪伴等级3：星环':'陪伴等级2：星光';
  if(adornment.hidden!==hidden)adornment.hidden=hidden;if(adornment.textContent!==text)adornment.textContent=text;if(adornment.title!==title)adornment.title=title;
}
async function interact(kind) {try {await api?.interact?.(kind);} catch {bubble.textContent='这次没有响应，再试一次吧。';bubble.hidden=false;}}
function finishInteraction({pointerId,cancelled,paused}) {
  if(!pointer||pointer.id!==pointerId)return;
  const click=!pointer.moved&&!cancelled,held=performance.now()-pointer.time;pointer=null;
  scheduler.setContext({dragging:false,paused:paused||hostPaused||document.hidden});
  refresh();
  if(click&&performance.now()-lastInteraction>1200){lastInteraction=performance.now();void interact(held>700?'thanks':'pet');}
}
window.andromedaEnhancements = {
  finishDrag:finishInteraction,
  busy:()=>scheduler.isActive(),
  reduced:()=>Boolean(publicState?.preferences?.reducedMotion),
  gaze:(x,y)=>{if(!custom)return false;if(!activeId&&!surfacePaused)custom.gaze(x,y);return true;},
  neutralGaze:()=>{if(custom&&!activeId&&!pointer){custom.neutral();customAction=null;}},
  idle:()=>{if(!connected)return false;scheduler.enqueue({id:'idle-'+Date.now(),kind:'idle',action:basePose(),priority:10,durationMs:1500,resumable:false});refresh();return true;},
  manual(action) {
    if(!connected)return false;
    const semantic={wave:'greet',jump:'happy',wait:'think',review:'read'}[action];if(!semantic)return false;
    scheduler.clear({kind:'manual'});scheduler.enqueue({id:'manual-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),kind:'manual',action:semantic,text:'',priority:80,durationMs:2200,resumable:false});refresh();return true;
  },
  onState(state) {hostPaused=!!state.fullscreenSuppressed;scheduler.setContext({hidden:state.visible===false || !!state.dock?.collapsed || !!state.clickThroughActive,paused:hostPaused||document.hidden,reducedMotion:reduced.matches||!!state.companion?.preferences?.reducedMotion});updatePublic(state.companion);refresh();},
  // The classic surface calls this after resetting its previous frame/timer.
  onVisibility() {scheduler.setContext({paused:hostPaused||document.hidden});refresh();},
  connect(value) {
    connected=value;resolve=createActionResolver(characterPackFromAtlas(value.manifest));
    const canvas=value.canvas;
    // Only opaque character pixels count as a touch. This does not enable OS click-through.
    canvas.addEventListener('pointerdown',event=>{
      if(event.button!==0||pointer)return;
      const rect=canvas.getBoundingClientRect(),x=Math.floor((event.clientX-rect.left)*canvas.width/rect.width),y=Math.floor((event.clientY-rect.top)*canvas.height/rect.height);
      if(x<0||y<0||x>=canvas.width||y>=canvas.height)return;
      const opaque=custom?custom.hitTest(x*pose.width/canvas.width,y*pose.height/canvas.height):publicState?.preferences?.visualStyle==='studio'&&!pose.hidden
        ? poseContext.getImageData(Math.floor(x*2),Math.floor(y*2),1,1).data[3]>16
        : canvas.getContext('2d').getImageData(x,y,1,1).data[3]>16;
      if(!opaque){event.stopImmediatePropagation();return;}
      pointer={id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now(),moved:false};
      scheduler.setContext({dragging:true});displayPose('drag');refresh();
    },true);
    canvas.addEventListener('pointermove',event=>{if(pointer?.id===event.pointerId&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>5)pointer.moved=true;});
    api?.onEvent?.(event=>{try{scheduler.enqueue({...event,durationMs:4000});refresh();}catch{}});
    api?.onPublic?.(updatePublic);api?.onCharacter?.(value=>{void applyCustom(value);});if(api?.getCharacter)void api.getCharacter().then(applyCustom).catch(()=>{});displayPose('idle');refresh();
    api?.onRhythm?.(level=>{const amount=reduced.matches||publicState?.preferences.reducedMotion||pointer?0:Math.min(1,Math.max(0,Number(level)||0));document.body.style.setProperty('--rhythm-y',`${-2*amount}px`);});
  },
};
panelButton.addEventListener('click',()=>{void api?.showCompanion?.().catch(()=>{});});
bubble.addEventListener('click',()=>{bubble.hidden=true;void api?.showCompanion?.().catch(()=>{});});
reduced.addEventListener('change',()=>{scheduler.setContext({reducedMotion:reduced.matches||!!publicState?.preferences?.reducedMotion});refresh();});
window.addEventListener('beforeunload',()=>{customGeneration++;custom?.destroy();clearTimeout(timer);});
