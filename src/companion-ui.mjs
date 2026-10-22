import {characterPackFromAtlas} from './shared/character.mjs';
import {mountCharacterEditor} from './character-editor.mjs';
import {mountAmbience} from './ambience-ui.mjs';
const api = window.andromeda;
const $ = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
let companion, assistant, streaming = null, activeTab = 'today', image = null, recorder = null, recordingTimer, audioContext, audioSource;
let configRendered = false, profileRendered = false, lastHistory = '', lastList = '', bridge = {enabled: false}, ambience, mediaEpoch=0, audioEpoch=0;
let closing=false, editor, restoreData, gameTimer, gameTicks=0, score=0;
const labels = {today:'今天',tasks:'专注与待办',chat:'聊一会儿',memory:'记忆手册',appearance:'星璇图鉴',preferences:'偏好与连接'};
function show(message, error = false) { $('#status').textContent = message; $('#status').hidden = !message; $('#status').dataset.error = String(error); }
async function invoke(callback) { try { return await callback(); } catch (error) { show(error?.message || '操作暂未完成，请重试。', true); return null; } }
async function command(type, payload = {}) { const result = await api.command({type, ...payload}); if (result?.state) renderCompanion(result.state); if (result?.persistenceError) show(result.persistenceError, true); return result; }
async function service(method, payload) { return api.assistant({method, payload}); }
function tab(name) {
  if (!Object.hasOwn(labels, name)) return;
  activeTab = name; all('[data-panel]').forEach(el => { el.hidden = el.dataset.panel !== name; });
  all('[data-tab]').forEach(el => { if (el.dataset.tab === name) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = '陪伴空间 / ' + labels[name];
  if(name==='today' && api.shortcuts)void invoke(()=>loadShortcuts());
}
async function loadShortcuts(action='list',id) {
  const rows=await api.shortcuts({action,...(id?{id}:{})});
  if(action==='launch')show('已交给系统打开应用。');
  list('#app-shortcuts',rows,entry=>item(entry.name,'',[['打开',()=>loadShortcuts('launch',entry.id)],['移除',()=>loadShortcuts('remove',entry.id)]]),'还没有快捷应用，可选择自己常用的程序。');
}
function button(label, callback) { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.addEventListener('click', () => void invoke(callback)); return el; }
function item(text, detail, actions = [], className = '') {
  const el = document.createElement('div'); el.className = 'item ' + className;
  const p = document.createElement('p'); p.textContent = text; el.append(p);
  if (detail) { const small = document.createElement('small'); small.textContent = detail; el.append(small); }
  const row = document.createElement('div'); row.className = 'actions'; actions.forEach(([label, callback]) => row.append(button(label, callback))); el.append(row); return el;
}
function list(selector, entries, render, emptyText) {
  const target = $(selector); target.replaceChildren();
  entries.forEach(entry => target.append(render(entry)));
  if (!entries.length) { const el = document.createElement('div'); el.className = 'empty'; el.textContent = emptyText; target.append(el); }
}
function formatTime(value) { return new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function renderCompanion(state) {
  if (!state?.profile) return; companion = state;
  $('#hello').textContent = `你好，${state.profile.ownerName}。`;
  $('#mood').textContent=state.focus.status==='running'?'陪你专注中':state.mood.value>=15?'今天心情轻快':state.mood.value<0?'慢一点也没关系':'安静陪在你身边';
  $('#sessions').textContent = state.progression.focusSessions; $('#completed').textContent = state.progression.completedTodos;
  $('#level').textContent = String(state.progression.level).padStart(2,'0'); $('#xp').textContent = `${state.progression.xp} 星光 · 不会断签扣分`;
  $('#growth-unlocks').textContent=state.progression.level>=3?'星光与星环饰物已解锁，会陪你一起出现在桌面。':state.progression.level>=2?'星光饰物已解锁。累积 400 星光可解锁星环。':`再累积 ${Math.max(0,100-state.progression.xp)} 星光，解锁第一枚星光饰物。`;
  $('#routine').textContent = ({morning:'早上好，慢慢开始今天',day:'一颗星，陪你把今天过好',evening:'今天也辛苦了',night:'夜深了，也记得照顾自己'}[state.routine?.period] || '一颗星，陪你把今天过好');
  const focus = state.focus, remaining = ['running','paused','break','completed'].includes(focus.status) ? focus.remainingMs : Number($('#focus-minutes').value || 25) * 60000;
  if(focus.status==='running'&&gameTicks>0)stopGame('专注开始，星星先收好。');
  $('#timer').textContent = `${String(Math.floor(Math.ceil(remaining / 1000) / 60)).padStart(2,'0')}:${String(Math.ceil(remaining / 1000) % 60).padStart(2,'0')}`;
  $('#focus-label').textContent = ({idle:'准备好了就开始',running:'一起专注中',paused:'暂停了，回来再继续',break:'休息也是计划的一部分',completed:'这一段完成啦',cancelled:'已取消，随时重新开始'}[focus.status]);
  $('#focus-start').disabled = ['running','paused','break'].includes(focus.status);
  $('#focus-pause').hidden = !['running','break'].includes(focus.status); $('#focus-resume').hidden = focus.status !== 'paused';
  $('#focus-finish').hidden = !['running','paused'].includes(focus.status) || focus.phase === 'break';
  $('#focus-break').hidden = focus.status !== 'completed'; $('#focus-cancel').hidden = !['running','paused','break'].includes(focus.status);
  $('#mute-reminders').checked = state.preferences.remindersMuted;
  $('#visual-style').value=state.preferences.visualStyle;$('#theme').value=state.preferences.theme;$('#movement').value=state.preferences.movement;$('#reduce-motion').checked=state.preferences.reducedMotion;
  if (!profileRendered) { $('#owner-name').value = state.profile.ownerName; $('#pet-name').value = state.profile.name; $('#persona').value = state.profile.persona; profileRendered = true; }
  const signature = JSON.stringify([state.todos,state.notifications,state.memories,state.tasks]);
  if (signature === lastList) return; lastList = signature;
  const currentTask = $('#focus-task').value; $('#focus-task').replaceChildren(new Option('自由专注',''));
  state.todos.filter(entry => entry.status === 'open').forEach(entry => $('#focus-task').add(new Option(entry.text,entry.id))); $('#focus-task').value = currentTask;
  list('#todos', [...state.todos].reverse(), entry => item(entry.text, entry.dueAt ? '提醒：' + formatTime(entry.dueAt) : '无提醒时间', [
    ...(entry.status === 'open' ? [['完成', () => command('todo.complete',{id:entry.id})],['10 分钟后提醒', () => command('todo.snooze',{id:entry.id,minutes:10})],['编辑', () => editTodo(entry)]] : []),
    ['删除', () => command('todo.delete',{id:entry.id})]], entry.status), '把第一件想做的事写下来吧。');
  list('#notifications', [...state.notifications].reverse(), entry => item(entry.count > 1 ? `${entry.text} · 共 ${entry.count} 条` : entry.text, formatTime(entry.updatedAt), [['查看详情', () => {tab('tasks'); show(entry.items.map(row => row.text).join('；'));}],['收好', () => command('notification.ack',{id:entry.id})]]), '这里很安静。新的提醒会放在这里。');
  list('#memories', [...state.memories].reverse(), entry => item(entry.text, `${entry.source} · ${formatTime(entry.updatedAt)}`, [['修改', () => editMemory(entry)], ['忘记', () => command('memory.forget',{id:entry.id})]]), '还没有记忆。只记下你主动告诉我的事。');
  list('#external-tasks', [...state.tasks].reverse(), entry => item(entry.title, `${({working:'进行中',waiting:'等你确认',completed:'已完成',failed:'未完成',cancelled:'已取消'})[entry.status]} · ${entry.text}`, [['任务详情',()=>show(`${entry.title} · ${entry.id} · ${formatTime(entry.updatedAt)}\n${entry.text || '没有额外描述'}`)]]), '还没有接入的创作任务。');
}
function editInline(entry, selector, save) {
  const nodes = [...$(selector).children], node = nodes.find(el => el.querySelector('p')?.textContent === entry.text);
  if (!node) return;
  const input = document.createElement('textarea'); input.value = entry.text; input.maxLength = selector === '#memories' ? 2000 : 500; input.rows = 3;
  node.replaceChildren(input, button('保存修改', async () => { await save(input.value); lastList = ''; renderCompanion(companion); })); input.focus();
}
function editTodo(entry) { editInline(entry,'#todos', text => command('todo.update',{id:entry.id,patch:{text}})); }
function editMemory(entry) { editInline(entry,'#memories', text => command('memory.update',{id:entry.id,text})); }
function message(role, text) { const el = document.createElement('div'); el.className = `message ${role}`; el.textContent = text; $('#chat-history').append(el); $('#chat-history').scrollTop = $('#chat-history').scrollHeight; return el; }
function renderAssistant(next) {
  if (!next) return; assistant = next;
  $('#chat-connection').textContent = next.enabled && next.model ? `${next.model} · ${next.endpoint} · ${next.status.kind === 'idle' ? '可以开始对话' : '正在处理，可随时停止'}` : '配置自己的模型服务后开启对话。未开启时，专注与陪伴照常可用。';
  $('#ai-usage').textContent = `今日 ${next.usage?.requests || 0} / ${next.dailyRequestLimit} 次 · UTC 零点重置 · 密钥${next.keyStorage === 'encrypted' ? '已由系统加密' : next.hasApiKey ? '仅保留在本次会话' : '尚未设置'}`;
  $('#chat-send').disabled = !next.enabled || !next.model; $('#voice-input').disabled = !next.enabled || !next.asrModel;
  $('#speak-reply').disabled = !next.enabled || !next.ttsModel; $('#capture-screen').disabled = !next.captureEnabled;
  if (!configRendered) {
    $('#ai-enabled').checked = next.enabled; $('#ai-endpoint').value = next.endpoint; $('#ai-model').value = next.model;
    $('#ai-asr').value = next.asrModel; $('#ai-tts').value = next.ttsModel; $('#ai-voice').value = next.voice;
    $('#ai-limit').value = next.dailyRequestLimit; $('#ai-capture').checked = next.captureEnabled; $('#ai-tools').checked = next.toolsEnabled; configRendered = true;
  }
  const history = JSON.stringify(next.history);
  if (!streaming && history !== lastHistory) { lastHistory = history; $('#chat-history').replaceChildren(); next.history.forEach(entry => message(entry.role,entry.content)); if (!next.history.length) message('assistant','你好，想说点什么都可以。对话服务按需开启。'); }
  list('#tool-cards',next.pendingTools,card => item(card.label || card.name, JSON.stringify(card.args), [['确认执行', () => confirmTool(card,true)],['取消', () => confirmTool(card,false)]]),'暂无等待确认的操作。');
}
async function confirmTool(card,confirmed){
  try{await service('confirmTool',{id:card.id,confirmed});$('#tool-receipts').prepend(item(card.label||card.name,confirmed?'已执行完成。':'已取消，未执行。'));}
  catch(error){$('#tool-receipts').prepend(item(card.label||card.name,'执行未完成：'+(error.message||'请重试')));throw error;}
  finally{while($('#tool-receipts').children.length>10)$('#tool-receipts').lastElementChild.remove();}
}
function receive(update) {
  if(update.hostPaused){cancelRecording();stopAudio();stopGame('已暂停');ambience?.stop();image=null;$('#capture-preview').hidden=true;}
  if (update.companion) renderCompanion(update.companion); if (update.assistant) renderAssistant(update.assistant);
  if (update.persistenceError) show(update.persistenceError,true);
  const event = update.assistantEvent;
  if (event?.type === 'assistant:delta') { if (!streaming) streaming = message('assistant',''); streaming.textContent += event.text; $('#chat-history').scrollTop = $('#chat-history').scrollHeight; }
  if (event?.type === 'assistant:error') show(event.message,true);
}
all('[data-tab],[data-go]').forEach(el => el.addEventListener('click', () => tab(el.dataset.tab || el.dataset.go)));
$('.brand').addEventListener('click',event => {event.preventDefault();tab('today');});
$('#window-settings').addEventListener('click', () => void invoke(() => api.showSettings()));
all('[data-link]').forEach(el => el.addEventListener('click', () => void invoke(() => api.openLink(el.dataset.link))));
all('[data-command]').forEach(el => el.addEventListener('click', () => void invoke(() => command('interaction',{kind:el.dataset.command}))));
all('[data-action]').forEach(el => el.addEventListener('click', () => void invoke(() => api.playAction(el.dataset.action))));
$('#clear-notifications').addEventListener('click', () => void invoke(() => command('notification.clear')));
$('#add-shortcut').addEventListener('click',()=>void invoke(()=>loadShortcuts('add')));
$('#focus-start').addEventListener('click', () => void invoke(() => command('focus.start',{durationMinutes:Number($('#focus-minutes').value),...($('#focus-task').value ? {taskId:$('#focus-task').value} : {})})));
for (const action of ['pause','resume','finish','break','cancel']) $('#focus-'+action).addEventListener('click', () => void invoke(() => command('focus.'+action)));
$('#todo-form').addEventListener('submit',event => {event.preventDefault();void invoke(async () => {await command('todo.add',{text:$('#todo-text').value,...($('#todo-due').value ? {dueAt:new Date($('#todo-due').value).getTime()} : {})});$('#todo-form').reset();});});
$('#mute-reminders').addEventListener('change', () => void invoke(() => command('reminders.mute',{muted:$('#mute-reminders').checked})));
for(const [id,key]of[['visual-style','visualStyle'],['theme','theme'],['movement','movement']])$('#'+id).addEventListener('change',()=>void invoke(()=>command('preferences.update',{patch:{[key]:$('#'+id).value}})));
$('#reduce-motion').addEventListener('change',()=>void invoke(()=>command('preferences.update',{patch:{reducedMotion:$('#reduce-motion').checked}})));
$('#toss').addEventListener('click',()=>void invoke(()=>api.toss()));
all('[data-reminder]').forEach((el,i) => el.addEventListener('click', () => void invoke(() => command('todo.add',{text:el.dataset.reminder,dueAt:Date.now()+(i+1)*30*60000}))));
$('#memory-form').addEventListener('submit',event => {event.preventDefault();void invoke(async () => {await command('memory.add',{text:$('#memory-text').value,source:'主人主动记录'});$('#memory-form').reset();});});
$('#profile-form').addEventListener('submit',event => {event.preventDefault();void invoke(async () => {await command('profile.update',{patch:{name:$('#pet-name').value,ownerName:$('#owner-name').value,persona:$('#persona').value}});show('相处方式已保存。');});});
$('#assistant-config').addEventListener('submit',event => {event.preventDefault();void invoke(async () => {
  const patch = {enabled:$('#ai-enabled').checked,endpoint:$('#ai-endpoint').value,model:$('#ai-model').value,asrModel:$('#ai-asr').value,ttsModel:$('#ai-tts').value,voice:$('#ai-voice').value,dailyRequestLimit:Number($('#ai-limit').value),captureEnabled:$('#ai-capture').checked,toolsEnabled:$('#ai-tools').checked,persona:companion.profile.persona};
  if ($('#ai-key').value) patch.apiKey = $('#ai-key').value;
  try { renderAssistant(await service('configure',patch)); show('连接设置已保存。未发送测试请求。'); } finally { $('#ai-key').value = ''; }
});});
$('#chat-form').addEventListener('submit',event => {event.preventDefault();void invoke(async () => {
  const text = $('#chat-text').value.trim(); if (!text) return;
  message('user',text); streaming = message('assistant',''); $('#chat-send').disabled = true;
  const payload = {text,...(image ? {image} : {}),...($('#use-memory').checked ? {memory:companion.memories.map(entry=>entry.text).join('\n').slice(0,4000)} : {})};
  try { await service('chat',payload); $('#chat-text').value=''; image=null; $('#capture-preview').hidden=true; }
  finally { streaming=null; receive(await api.companionState()); }
});});
$('#chat-cancel').addEventListener('click', () => void invoke(async () => {cancelRecording();await service('cancel');stopAudio();show('已停止。');}));
$('#clear-chat').addEventListener('click', () => void invoke(async () => {streaming=null;lastHistory='';renderAssistant(await service('clearHistory'));}));
$('#tool-form').addEventListener('submit',event => {event.preventDefault();void invoke(() => service('proposeTool',{name:$('#tool-name').value,args:$('#tool-name').value==='addTodo'?{text:$('#tool-text').value}:{}}));});
$('#capture-screen').addEventListener('click', () => void invoke(async () => {const result=await service('captureOnce',{confirmed:true});image=result.image;$('#capture-image').src=image;$('#capture-preview').hidden=false;}));
$('#remove-capture').addEventListener('click', () => {image=null;$('#capture-image').removeAttribute('src');$('#capture-preview').hidden=true;});
function stopAudio() {audioEpoch++;try {audioSource?.stop();} catch {} audioSource=null; }
function cancelRecording(){mediaEpoch++;if(recorder){recorder.discard=true;if(recorder.state==='recording')recorder.stop();recorder.stream?.getTracks().forEach(track=>track.stop());}clearTimeout(recordingTimer);}
$('#stop-audio').addEventListener('click', () => {stopAudio();cancelRecording();void invoke(()=>service('cancel'));});
$('#speak-reply').addEventListener('click', () => void invoke(async () => {
  const text = [...(assistant?.history || [])].reverse().find(entry=>entry.role==='assistant')?.content;
  if (!text) {show('先聊一句，再朗读回复。');return;}
  audioContext ||= new AudioContext();stopAudio();const epoch=audioEpoch;await audioContext.resume();if(epoch!==audioEpoch)return;
  const result = await service('synthesize',{text}); const bytes=Uint8Array.from(atob(result.audioBase64),c=>c.charCodeAt(0));
  const buffer=await audioContext.decodeAudioData(bytes.buffer);if(epoch!==audioEpoch)return;audioSource=audioContext.createBufferSource();audioSource.buffer=buffer;audioSource.connect(audioContext.destination);audioSource.start();
}));
$('#voice-input').addEventListener('click', () => void invoke(async () => {
  if (recorder?.state==='recording') {recorder.stop();return;}
  const epoch=++mediaEpoch;await api.voicePermission();if(epoch!==mediaEpoch)return;const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});if(epoch!==mediaEpoch){stream.getTracks().forEach(track=>track.stop());return;}
  const chunks=[];let size=0;recorder=new MediaRecorder(stream,{mimeType:'audio/webm'});const currentRecorder=recorder;
  recorder.addEventListener('dataavailable',event=>{size+=event.data.size;if(size<=8*1024*1024)chunks.push(event.data);else recorder.stop();});
  recorder.addEventListener('stop',()=>{clearTimeout(recordingTimer);stream.getTracks().forEach(track=>track.stop());$('#voice-input').textContent='按下开始录音';if(currentRecorder.discard)return;void invoke(async()=>{if(size>8*1024*1024)throw new Error('录音过长，请缩短后重试。');const audio=new Uint8Array(await new Blob(chunks,{type:'audio/webm'}).arrayBuffer());if(currentRecorder.discard)return;const result=await service('transcribe',{audio,mimeType:'audio/webm'});$('#chat-text').value=result.text;show('识别完成。请检查文字后发送。');});},{once:true});
  recorder.start(250);recordingTimer=setTimeout(()=>{if(recorder?.state==='recording')recorder.stop();},60000);$('#voice-input').textContent='停止录音（最长 60 秒）';
}));
all('[data-export]').forEach(el=>el.addEventListener('click',()=>void invoke(async()=>{if(await api.exportData(el.dataset.export))show('已导出。');})));
$('#import-preferences').addEventListener('change',()=>void invoke(async()=>{const file=$('#import-preferences').files[0];if(!file)return;if(file.size>65536)throw new Error('偏好文件过大。');await command('preferences.import',{data:JSON.parse(await file.text())});show('偏好已导入，私人数据未改变。');}));
for(const [id,enabled]of[['enable-autostart',true],['disable-autostart',false]])$('#'+id).addEventListener('click',()=>void invoke(async()=>{await api.autostart(enabled);show(enabled?'已启用开机启动。':'已关闭开机启动。');}));
for(const [id,enabled]of[['enable-web-return',true],['disable-web-return',false]])$('#'+id).addEventListener('click',()=>void invoke(async()=>{const result=await api.registerDeepLink(enabled);show(result.enabled?'已启用网页中的“回桌面”入口。':'已关闭网页唤起入口。');}));
$('#bridge-toggle').addEventListener('click',()=>void invoke(async()=>{bridge=await api.taskBridge(!bridge.enabled);$('#bridge-toggle').textContent=bridge.enabled?'关闭本机任务桥':'开启本机任务桥';$('#bridge-help').textContent=bridge.enabled?`POST http://127.0.0.1:${bridge.port}/events\nAuthorization: Bearer ${bridge.token}\nContent-Type: application/json\n\n${JSON.stringify({eventId:'build-1',taskId:'my-project',status:'completed',title:'项目构建',text:'构建完成'},null,2)}\n\n令牌只在本机显示，重启或关闭后失效。`:'事件桥已关闭。';}));
function stopGame(message=''){clearInterval(gameTimer);gameTimer=null;gameTicks=0;$('#catch-star').hidden=true;$('#star-game').disabled=false;$('#game-status').textContent=message;}
$('#star-game').addEventListener('click',()=>void invoke(async()=>{if(companion.focus.status==='running')throw new Error('专注中先保持安静，暂停后再玩吧。');stopGame();score=0;gameTicks=10;$('#catch-star').hidden=false;$('#star-game').disabled=true;$('#game-status').textContent='接住星星 · 10 秒';gameTimer=setInterval(()=>{gameTicks--;$('#game-status').textContent=`${gameTicks} 秒 · 接住 ${score} 次`;if(gameTicks<=0){stopGame(`接住 ${score} 次，下次再玩。`);void invoke(()=>command('interaction',{kind:'play'}));}},1000);}));
$('#catch-star').addEventListener('click',()=>{score++;$('#catch-star').style.right=`${Math.round(Math.random()*70)}%`;$('#game-status').textContent=`${gameTicks} 秒 · 接住 ${score} 次`;});
$('#open-editor').addEventListener('click',()=>void invoke(async()=>{if(!editor){const manifest=await(await fetch('../assets/manifest.json')).json();editor=mountCharacterEditor({root:$('#editor-root'),initialPack:characterPackFromAtlas(manifest),onExport:async data=>{const saved=await api.exportCharacter(data);if(saved)show('角色图片与动作已一起导出为 ZIP。');return saved;}});await editor.ready;}$('#editor-dialog').showModal();}));
$('#close-editor').addEventListener('click',()=>$('#editor-dialog').close());
for(const[action,id]of[['import','import-character'],['clear','clear-character']])$('#'+id).addEventListener('click',()=>void invoke(async()=>{const result=await api.installCharacter(action);if(!result.cancelled){$('#custom-character-status').textContent=result.name?'当前使用：'+result.name:'当前使用内置外观。';show(result.name?'角色包已在本机保存并启用。':'已恢复内置角色。');}}));
$('#editor-dialog').addEventListener('close',()=>{editor?.destroy();editor=null;});
$('#import-backup').addEventListener('change',()=>void invoke(async()=>{restoreData=null;const file=$('#import-backup').files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('备份不能超过 2 MiB。');const data=JSON.parse(await file.text());const result=await api.restoreBackup({action:'preview',data});restoreData=data;const summary=result.summary||result;$('#restore-summary').textContent=`待办 ${summary.todos} 条 · 记忆 ${summary.memories} 条 · 消息 ${summary.notifications} 条\n陪伴等级 ${summary.level} · 恢复后专注${summary.focusPaused?'暂停':'保持原状态'}\n修复或丢弃 ${summary.discarded?.total||0} 条记录\n${(summary.warnings||[]).join('\n')}\n确认后将替换当前陪伴资料，并先在本机保存恢复前的旧档。AI 密钥不在此次恢复范围；人设变化会清空当前对话会话。`;$('#restore-dialog').showModal();}));
$('#cancel-restore').addEventListener('click',()=>$('#restore-dialog').close());
$('#restore-dialog').addEventListener('close',()=>{restoreData=null;$('#import-backup').value='';});
$('#confirm-restore').addEventListener('click',()=>void invoke(async()=>{if(!restoreData)return;$('#confirm-restore').disabled=true;try{await api.restoreBackup({action:'restore',data:restoreData});profileRendered=false;lastList='';receive(await api.companionState());$('#restore-dialog').close();show('备份已恢复。恢复前的旧档保留在本机数据目录。');}finally{$('#confirm-restore').disabled=false;}}));
ambience=mountAmbience({root:$('#ambience-root'),onLevel:level=>{if(!closing&&api.rhythm)void api.rhythm(level).catch(()=>{});}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopGame('已暂停');});
window.addEventListener('beforeunload',()=>{closing=true;stopGame();cancelRecording();stopAudio();ambience?.destroy();editor?.destroy();audioContext?.close();});
try {api.onCompanion(receive);receive(await api.companionState());const state=await api.getState();$('#app-version').textContent='ANDROMEDA · '+state.version;if(api.shortcuts)await loadShortcuts();}catch(error){show(error.message||'请从星璇应用打开陪伴空间。',true);}
