import {createCompanionEngine} from '../src/shared/companion.mjs';
import {resolveAction} from '../src/shared/character.mjs';
import {createBehaviorScheduler} from '../src/shared/behavior.mjs';
import {frameAt, cropRect, neutralDelay} from '../src/animation.mjs';
import {SITE_CONTENT, searchSiteContent, pageContent} from '../src/shared/site-content.mjs';
import {normalizeWebPreferences, exportWebPreferences, importWebPreferences, safeLink, cleanText, acceptTaskEvent, placeWidget, semanticAnimation, avoidOverlapPlacement} from './policy.mjs';
import {studioCrop} from './studio.mjs';
import {sameOriginAsset, prepareWebCharacter, nearestLookCell} from './character-loader.mjs';
import {createReadingProgress} from './reading.mjs';

/** Mount a self-contained, offline-first site companion. No global singleton or account service. */
export function mountAndromeda(options = {}) {
  const container = options.container || document.body;
  if (!container?.append) throw new TypeError('需要可挂载的 DOM 容器');
  const doc = container.ownerDocument, win = doc.defaultView;
  const abort = new AbortController(), signal = abort.signal;
  const storageKey = options.storageKey || 'andromeda.web.preferences.v1';
  let preferences;
  try { preferences = normalizeWebPreferences(JSON.parse(win.localStorage.getItem(storageKey))); } catch { preferences = normalizeWebPreferences(); }
  let destroyed = false, engine = createCompanionEngine({}, {role: 'visitor', timezoneOffsetMinutes: -new Date().getTimezoneOffset()}), sessionUser = null;
  const content = options.content || SITE_CONTENT;
  const scheduler = createBehaviorScheduler({maxQueue: 12});
  let manifest, pack, atlas, studioImage, studioPromise, posterLoaded = false, animationTimer, idleTimer, bubbleTimer, dockTimer;
  let action = null, drag = null, suppressClick = false, panelOpen = false, autoAvoid = false, tourIndex = -1, gameActive = false;
  let audioContext = null, lastNotice = 0, schedulerTimer, shownEvent = null;
  let typingCount = 0, typingActive = false, typingIdleTimer, typingPaintTimer;
  let layoutCollapsed = false, layoutOverride = false, layoutTimer, layoutObserver;
  const avoidSelectors = Array.isArray(options.avoidSelectors) ? options.avoidSelectors.filter(selector => typeof selector === 'string' && selector.length <= 200).slice(0, 16) : [];
  let readingTarget = null, readingTimer, readingView, readingState = {visibleMs: 0, progress: 0, eligible: false}, readingSaved = {earned: false, dismissed: false};
  const reading = options.reading;
  const readingKey = reading && /^[a-zA-Z0-9_.-]{1,80}$/.test(reading.id || '') ? `${storageKey}.reading.${reading.id}` : null;
  if (readingKey && ['article', 'project'].includes(reading.kind) && typeof reading.selector === 'string') {
    try { readingTarget = doc.querySelector(reading.selector); const stored = JSON.parse(win.localStorage.getItem(readingKey)); readingSaved = {earned: stored?.earned === true, dismissed: stored?.dismissed === true}; } catch { /* Invalid selector or storage leaves this optional feature unavailable. */ }
  }
  const readingProgress = createReadingProgress({minimumVisibleMs: reading?.minimumVisibleMs});
  const reducedMedia = win.matchMedia('(prefers-reduced-motion: reduce)');
  const host = doc.createElement('div'); host.dataset.andromeda = 'widget';
  const root = host.attachShadow({mode: 'open'});
  const el = (tag, props = {}, children = []) => { const node = doc.createElement(tag); for (const [key, value] of Object.entries(props)) key === 'text' ? node.textContent = value : node.setAttribute(key, value); node.append(...children); return node; };
  const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, {...opts, signal});
  const button = (text, fn, primary = false) => { const node = el('button', {type: 'button', class: `button${primary ? ' primary' : ''}`, text}); listen(node, 'click', fn); return node; };
  const stylesheet = el('link', {rel: 'stylesheet', href: new URL('./widget.css', import.meta.url).href});
  const canvas = el('canvas', {class: 'canvas', width: '192', height: '208', tabindex: '0', role: 'button', 'aria-label': '星璇：点击打开向导；拖动移动；左右方向键移动；Escape 收起', 'aria-haspopup': 'dialog', 'aria-expanded': 'false'});
  const poster = el('img', {class: 'poster', alt: '', hidden: ''});
  const fallback = el('span', {class: 'fallback', text: '✦', 'aria-hidden': 'true'});
  const badge = el('span', {class: 'badge', 'aria-hidden': 'true'});
  const character = el('div', {class: 'character'}, [fallback, poster, canvas, badge]);
  const restore = el('button', {class: 'restore', type: 'button', text: '✦ 星璇', 'aria-label': '展开星璇向导'});
  const bubbleText = el('span');
  const bubbleClose = el('button', {class: 'bubble-close', type: 'button', text: '×', 'aria-label': '关闭提示'});
  const bubble = el('div', {class: 'bubble', role: 'status', 'aria-live': 'polite', hidden: ''}, [bubbleText, bubbleClose]);
  const panel = el('section', {class: 'panel', role: 'dialog', 'aria-label': '星璇向导', hidden: ''});
  const pet = el('div', {class: 'pet'}, [character, restore, bubble, panel]);
  const highlight = el('div', {class: 'highlight', hidden: '', 'aria-hidden': 'true'});
  const safeArea = el('div', {'aria-hidden': 'true', style: 'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'});
  root.append(stylesheet, safeArea, highlight, pet); container.append(host);
  const ctx = canvas.getContext('2d');
  let assetBase, manifestUrl, resourceError;
  try {
    assetBase = sameOriginAsset(options.assetBase || '../assets/', import.meta.url, win.location.origin);
    manifestUrl = sameOriginAsset(options.characterPackUrl || new URL('manifest.json', assetBase), import.meta.url, win.location.origin);
  } catch (error) { resourceError = error; }
  const activeTimers = new Set();
  const later = (fn, ms) => { const timer = win.setTimeout(() => { activeTimers.delete(timer); if (!destroyed) fn(); }, ms); activeTimers.add(timer); return timer; };
  const cancel = timer => { if (timer !== undefined) { win.clearTimeout(timer); activeTimers.delete(timer); } };
  const reduced = () => reducedMedia.matches || preferences.reducedMotion;
  const suspended = () => destroyed || doc.hidden || !!doc.fullscreenElement || autoAvoid || preferences.collapsed;
  const viewport = () => { const style = win.getComputedStyle(safeArea), safeTop = parseFloat(style.paddingTop) || 0, safeBottom = parseFloat(style.paddingBottom) || 0; return {width: win.visualViewport?.width || win.innerWidth, height: (win.visualViewport?.height || win.innerHeight) - safeTop - safeBottom, left: win.visualViewport?.offsetLeft || 0, top: (win.visualViewport?.offsetTop || 0) + safeTop}; };
  const size = () => ({width: preferences.collapsed || autoAvoid || layoutCollapsed ? preferences.inputFeedback && typingActive && autoAvoid ? 128 : 94 : win.innerWidth <= 640 ? 96 : 128, height: preferences.collapsed || autoAvoid || layoutCollapsed ? 46 : (win.innerWidth <= 640 ? 96 : 128) * 208 / 192});
  function opaqueAt(point) {
    // Hit the current rendered frame, including the contain-fitted studio pose.
    // Static load failure retains a keyboard/pointer-accessible fallback control.
    if (!atlas && !studioImage) return true;
    if (!ctx) return false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = Math.floor((point.clientX - rect.left) * canvas.width / rect.width), y = Math.floor((point.clientY - rect.top) * canvas.height / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    try { return ctx.getImageData(x, y, 1, 1).data[3] >= 16; } catch { return false; }
  }
  function paintTyping() {
    typingPaintTimer = undefined;
    restore.textContent = preferences.inputFeedback && typingActive && autoAvoid ? `✦ 输入中 · ${Math.min(9999, typingCount)}` : '✦ 星璇';
    restore.dataset.typing = String(preferences.inputFeedback && typingActive && autoAvoid);
    place();
  }
  function stopTyping() { cancel(typingIdleTimer); cancel(typingPaintTimer); typingIdleTimer = typingPaintTimer = undefined; typingActive = false; paintTyping(); }
  function save() { try { win.localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* The companion remains usable without browser storage. */ } options.onPreferencesChange?.(exportWebPreferences(preferences)); }
  function place() {
    if (drag?.moved) { positionHighlight(); return; }
    const view = viewport(), alreadyCompact = preferences.collapsed || autoAvoid;
    const naturalWidth = win.innerWidth <= 640 ? 96 : 128, fullSize = {width: naturalWidth, height: naturalWidth * 208 / 192};
    const compactSize = {width: preferences.inputFeedback && typingActive && autoAvoid ? 128 : 94, height: 46};
    const obstacles = [];
    for (const selector of avoidSelectors) {
      let targets; try { targets = doc.querySelectorAll(selector); } catch { continue; }
      for (const target of targets) {
        if (obstacles.length >= 64) break;
        const rect = target.getBoundingClientRect();
        if (rect.width && rect.height && rect.right > view.left && rect.left < view.left + view.width && rect.bottom > view.top && rect.top < view.top + view.height) obstacles.push({left: rect.left - view.left, right: rect.right - view.left, top: rect.top - view.top, bottom: rect.bottom - view.top});
      }
    }
    const placement = avoidOverlapPlacement(preferences, view, alreadyCompact ? compactSize : fullSize, compactSize, obstacles, {forceExpanded: layoutOverride});
    layoutCollapsed = !alreadyCompact && placement.collapsed;
    const collapsed = alreadyCompact || layoutCollapsed;
    character.hidden = collapsed; restore.hidden = !collapsed; pet.classList.toggle('is-collapsed', collapsed);
    restore.title = layoutCollapsed ? '附近入口需要空间，点击手动展开星璇' : '展开星璇向导';
    if (layoutCollapsed) { stopAnimation(); hideBubble(); }
    const point = placement.point;
    const frameWidth = win.innerWidth <= 640 ? 96 : 128, frameHeight = frameWidth * 208 / 192;
    const scale = Math.min(frameWidth / canvas.width, frameHeight / canvas.height);
    character.style.height = `${frameHeight}px`; canvas.style.width = `${canvas.width * scale}px`; canvas.style.height = `${canvas.height * scale}px`;
    pet.style.left = `${Math.round(point.left + view.left)}px`; pet.style.top = `${Math.round(point.top + view.top)}px`;
    bubble.style.right = point.left < view.width / 2 ? 'auto' : '0'; bubble.style.left = point.left < view.width / 2 ? '0' : 'auto';
    const roomAbove = point.top > 150;
    bubble.style.bottom = roomAbove ? 'calc(100% + 10px)' : 'auto'; bubble.style.top = roomAbove ? 'auto' : 'calc(100% + 10px)';
    if (win.innerWidth > 640) { panel.style.left = `${Math.max(16, Math.min(view.width - 376, point.left - 230)) + view.left}px`; panel.style.right = 'auto'; panel.style.top = `${Math.max(16, Math.min(view.height - Math.min(600, view.height - 32), point.top - 420)) + view.top}px`; panel.style.bottom = 'auto'; }
    positionHighlight();
  }
  function draw(row = manifest?.neutral?.row || 0, column = manifest?.neutral?.column || 0) {
    if (preferences.visualStyle === 'studio' && studioImage) { drawStudio(); return; }
    if (!ctx || !atlas || !manifest || suspended()) return;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(atlas, ...cropRect(manifest.atlas, row, column), 0, 0, canvas.width, canvas.height);
      canvas.dataset.row = String(row); canvas.dataset.column = String(column); poster.hidden = true; fallback.hidden = true;
    } catch { atlas = null; canvas.dataset.assetState = 'fallback'; poster.hidden = !posterLoaded; fallback.hidden = posterLoaded; stopAnimation(); }
  }
  function drawStudio(semantic = 'idle') {
    if (!ctx || !studioImage || suspended()) return;
    const pose = studioCrop(semantic, studioImage.naturalWidth, studioImage.naturalHeight), [, , width, height] = pose.rect;
    const scale = Math.min(canvas.width / width, canvas.height / height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(studioImage, ...pose.rect, (canvas.width - width * scale) / 2, canvas.height - height * scale, width * scale, height * scale);
    canvas.dataset.pose = semantic; canvas.dataset.visualStyle = 'studio'; poster.hidden = fallback.hidden = true;
  }
  function ensureStudio() {
    if (preferences.visualStyle !== 'studio' || studioImage || studioPromise || destroyed) return;
    canvas.dataset.studioState = 'loading';
    studioPromise = loadImage(new URL(options.studioUrl || '../assets/studio/life-poses-v1.png', import.meta.url)).then(image => {
      if (destroyed) return;
      if (image.naturalWidth !== 1254 || image.naturalHeight !== 1254) throw new Error('静态姿态图尺寸不匹配');
      studioImage = image; canvas.dataset.studioState = 'ready'; if (preferences.visualStyle === 'studio') { stopAnimation(); drawStudio(); }
    }).catch(() => { if (!destroyed) { canvas.dataset.studioState = 'fallback'; options.onError?.({code: 'STUDIO_UNAVAILABLE', message: '静态姿态暂不可用，继续显示经典星璇。'}); } }).finally(() => { studioPromise = null; });
  }
  function stopAnimation() { cancel(animationTimer); cancel(idleTimer); animationTimer = idleTimer = undefined; action = null; }
  function scheduleIdle() {
    cancel(idleTimer);
    if (suspended() || layoutCollapsed || reduced() || panelOpen || !atlas || (preferences.visualStyle === 'studio' && studioImage)) return;
    const delay = neutralDelay(preferences.motion);
    if (delay !== null) idleTimer = later(() => play(Math.random() < .8 ? 'idle' : 'read'), delay);
  }
  function play(semantic) {
    if (suspended() || layoutCollapsed || !atlas || !manifest || drag) return false;
    stopAnimation();
    if (preferences.visualStyle === 'studio' && studioImage) { drawStudio(semantic); animationTimer = later(() => drawStudio(), 1800); return true; }
    let resolved;
    try { resolved = pack ? resolveAction(pack, semantic, {reducedMotion: reduced()}) : null; } catch { return false; }
    const name = Object.hasOwn(manifest.animations, semantic) ? semantic : resolved?.animation || semanticAnimation(semantic, manifest), clip = manifest.animations[name];
    if (!clip) { draw(resolved?.row, resolved?.column); scheduleIdle(); return true; }
    action = {name, start: win.performance.now()};
    if (reduced() || preferences.motion === 'still') { draw(clip.row, 0); animationTimer = later(() => { action = null; draw(); scheduleIdle(); }, 700); return true; }
    const step = () => {
      if (!action || suspended()) return;
      const frame = frameAt(clip, win.performance.now() - action.start, 1.5);
      if (frame) { draw(frame.row, frame.column); animationTimer = later(step, Math.max(16, frame.remainingMs)); }
      else { action = null; draw(); scheduleIdle(); }
    };
    step(); return true;
  }
  function chime() {
    if (!preferences.sound || suspended() || !win.navigator.userActivation?.hasBeenActive) return;
    try {
      const Audio = win.AudioContext || win.webkitAudioContext; if (!Audio) return;
      audioContext ||= new Audio(); if (audioContext.state !== 'running') return;
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.frequency.setValueAtTime(660, audioContext.currentTime); gain.gain.setValueAtTime(.025, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .18);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .18);
    } catch { /* Text stays available if audio is unavailable. */ }
  }
  function say(text, {action: semantic = 'notify', force = false, duration = 6500} = {}) {
    const clean = cleanText(text); if (!clean || suspended() || layoutCollapsed || (!force && (panelOpen || Date.now() - lastNotice < 20000))) return false;
    lastNotice = Date.now(); bubbleText.textContent = clean; bubble.hidden = false; cancel(bubbleTimer); bubbleTimer = later(hideBubble, duration); place(); play(semantic); chime(); return true;
  }
  function hideBubble() { bubble.hidden = true; cancel(bubbleTimer); }
  function pumpEvents() {
    cancel(schedulerTimer);
    scheduler.setContext({hidden: suspended() || layoutCollapsed, paused: panelOpen, dragging: !!drag, reducedMotion: reduced()});
    const state = scheduler.tick();
    if (state.active && !state.paused && state.active.id !== shownEvent) {
      shownEvent = state.active.id; say(state.active.text, {action: state.active.action, force: true, duration: Math.max(1500, state.active.remainingMs)});
    }
    if (!state.paused && (state.active || state.queue.length)) schedulerTimer = later(pumpEvents, state.active ? Math.max(100, state.active.remainingMs) : 1000);
  }
  function handleEvents(result) {
    if (suspended()) return result;
    for (const event of result?.events || []) if (event.text) scheduler.enqueue({...event, durationMs: 6500, resumable: false});
    pumpEvents(); return result;
  }
  function interaction(kind) { if (preferences.interaction) return handleEvents(engine.dispatch({type: 'interaction', kind})); }
  function update(patch) { if (destroyed) return; preferences = normalizeWebPreferences({...preferences, ...patch}); save(); engine.dispatch({type: 'preferences.update', patch: {motion: preferences.motion, sound: preferences.sound, reducedMotion: reduced()}}); renderState(); }
  function renderState() {
    stopAnimation(); const collapsed = preferences.collapsed || autoAvoid;
    character.hidden = collapsed; restore.hidden = !collapsed; pet.classList.toggle('is-collapsed', collapsed); pet.dataset.theme = preferences.theme;
    pet.hidden = doc.hidden || !!doc.fullscreenElement;
    badge.textContent = preferences.seasonal ? (new Date().getMonth() >= 9 ? '✦' : '✿') : '';
    if (suspended()) { closePanel(false); hideBubble(); endTour(); scheduler.clear(); shownEvent = null; }
    if (!preferences.inputFeedback || doc.hidden || doc.fullscreenElement || !autoAvoid) stopTyping();
    updateReading();
    canvas.dataset.visualStyle = preferences.visualStyle === 'studio' && studioImage ? 'studio' : 'classic';
    ensureStudio(); place(); draw(); scheduleIdle(); pumpEvents();
  }
  function closePanel(focus = true) { panel.hidden = true; panelOpen = false; canvas.setAttribute('aria-expanded', 'false'); gameActive = false; endTour(); layoutOverride = false; place(); if (focus && !suspended() && !layoutCollapsed) canvas.focus({preventScroll: true}); scheduleIdle(); pumpEvents(); }
  function link(label, href) {
    const safe = safeLink(href, SITE_CONTENT.origin); if (!safe) return el('span', {text: label});
    const anchor = el('a', {class: 'link', href: safe, text: label, target: '_blank', rel: 'noopener noreferrer'}); return anchor;
  }
  function showResults(target, query) {
    target.replaceChildren(); const records = searchSiteContent(query, content);
    if (!records.length) target.append(el('p', {class: 'muted', text: '暂时没找到。试试“下载”“Unity”“游戏”或“隐私”。'}));
    for (const record of records) target.append(el('article', {class: 'result'}, [record.href ? link(record.title, record.href) : el('strong', {text: record.title}), el('p', {text: record.text})]));
  }
  function settingsRow(label, key) {
    const input = el('input', {type: 'checkbox'}); input.checked = preferences[key];
    listen(input, 'change', async () => {
      update({[key]: input.checked});
      if (key === 'sound' && input.checked) try { const Audio = win.AudioContext || win.webkitAudioContext; if (Audio) { audioContext ||= new Audio(); await audioContext.resume(); } } catch { input.checked = false; update({sound: false}); }
    });
    return el('label', {class: 'setting'}, [el('span', {text: label}), input]);
  }
  function saveReading() { try { win.localStorage.setItem(readingKey, JSON.stringify(readingSaved)); } catch { /* Memory-only stars still work. */ } }
  function updateReading() {
    cancel(readingTimer); readingTimer = undefined;
    if (!readingTarget?.isConnected || readingSaved.dismissed || readingSaved.earned) { paintReading(); return; }
    const rect = readingTarget.getBoundingClientRect();
    readingState = readingProgress.update({now: Date.now(), top: rect.top, height: rect.height, viewportHeight: win.innerHeight, enabled: preferences.readingRewards, visible: !doc.hidden && !doc.fullscreenElement});
    paintReading();
    if (preferences.readingRewards && !doc.hidden && !readingState.timeReady && rect.top < win.innerHeight && rect.bottom > 0) readingTimer = later(updateReading, 1000);
  }
  function paintReading() {
    if (!readingView?.isConnected) return;
    readingView.replaceChildren();
    if (!readingTarget || readingSaved.dismissed) return;
    const title = cleanText(reading.title || '这一页', 80);
    const text = readingSaved.earned ? `✦ ${title}的星光，已经收好了。` : readingState.eligible ? '这段停留已点亮一颗星光，可以收下。' : preferences.readingRewards ? `本段可见进度 ${Math.round(readingState.progress * 100)}% · 可见停留 ${Math.floor(readingState.visibleMs / 1000)} 秒` : '有一颗只属于本页的小星光。随时可以收下，不影响内容访问。';
    readingView.append(el('strong', {text: '本页小彩蛋'}), el('p', {class: 'muted', text}));
    if (!readingSaved.earned) readingView.append(button('收下这页星光', () => { readingSaved.earned = true; saveReading(); updateReading(); }, true));
    readingView.append(button('关闭本页彩蛋', () => { readingSaved.dismissed = true; saveReading(); updateReading(); }));
  }
  function open() {
    if (destroyed || doc.hidden || doc.fullscreenElement || autoAvoid) return;
    if (preferences.collapsed) update({collapsed: false, dock: null});
    hideBubble(); stopAnimation(); panelOpen = true; panel.hidden = false; canvas.setAttribute('aria-expanded', 'true');
    const close = button('×', () => closePanel()); close.className = 'close'; close.setAttribute('aria-label', '关闭向导面板');
    const current = pageContent(options.pathname || win.location.pathname, content);
    const search = el('input', {class: 'search', type: 'search', placeholder: '搜索工具、下载和常见问题', 'aria-label': '搜索站内公开内容', maxlength: '120'});
    const results = el('div', {class: 'results'}); showResults(results, ''); listen(search, 'input', () => showResults(results, search.value));
    const goals = el('div', {class: 'row', 'aria-label': '选择你想做的事情'}, (content.goals || []).map(goal => button(cleanText(goal.label, 40), () => { search.value = cleanText(goal.query, 120); showResults(results, search.value); results.scrollIntoView({block: 'nearest', behavior: 'instant'}); })));
    const motion = el('select', {'aria-label': '动作频率'});
    for (const [value, label] of [['quiet', '安静'], ['lively', '轻快'], ['still', '静止']]) { const option = el('option', {value, text: label}); option.selected = value === preferences.motion; motion.append(option); }
    listen(motion, 'change', () => update({motion: motion.value}));
    const theme = el('select', {'aria-label': '面板主题'});
    for (const [value, label] of [['night', '星夜'], ['dawn', '晨光'], ['festive', '节日']]) { const option = el('option', {value, text: label}); option.selected = value === preferences.theme; theme.append(option); }
    listen(theme, 'change', () => update({theme: theme.value}));
    const visualStyle = el('select', {'aria-label': '角色外观'});
    for (const [value, label] of [['classic', '经典 · 精灵动画'], ['studio', '星空画室 · 静态姿态']]) { const option = el('option', {value, text: label}); option.selected = value === preferences.visualStyle; visualStyle.append(option); }
    listen(visualStyle, 'change', () => update({visualStyle: visualStyle.value}));
    const importFile = el('input', {type: 'file', accept: '.json,application/json', class: 'file', 'aria-label': '导入偏好文件'});
    const status = el('p', {class: 'muted', role: 'status', text: '偏好仅保存在本浏览器；导出不包含位置、任务或记忆。'});
    listen(importFile, 'change', async () => { try { const file = importFile.files?.[0]; if (!file) return; if (file.size > 16384) throw new Error('文件过大'); const data = JSON.parse(await file.text()); preferences = importWebPreferences(data, preferences); save(); open(); } catch { status.textContent = '无法导入：请选择有效的星璇偏好 JSON 文件（不超过 16 KB）。'; } });
    const actions = el('div', {class: 'row'}, [button('挥挥手', () => { closePanel(false); interaction('greet'); play('greet'); }), button('摸摸头', () => { closePanel(false); interaction('pet'); play('happy'); }), button('收起', () => update({collapsed: true}))]);
    readingView = el('section', {class: 'reading-card', 'aria-label': '本页阅读彩蛋'});
    if (options.tour?.length) actions.prepend(button('带我逛逛', () => startTour(), true));
    panel.replaceChildren(
      el('div', {class: 'heading'}, [el('div', {}, [el('span', {class: 'eyebrow', text: 'ANDROMEDA / GUIDE'}), el('h2', {text: '星璇 · 你的站内向导'})]), close]),
      el('strong', {text: current.title}), el('p', {class: 'muted', text: current.text}), actions,
      goals, search, results, readingView,
      ...(readingTarget ? [settingsRow('本页阅读进度彩蛋', 'readingRewards'), el('p', {class: 'muted', text: '默认关闭；只计算这一段明确标记的公开文章或项目，不读取浏览历史。星光不是阅读证明，可手动领取。'})] : []),
      el('div', {class: 'divider'}), el('h3', {text: '舒服地陪着你'}),
      el('label', {class: 'setting'}, [el('span', {text: '动作频率'}), motion]),
      el('label', {class: 'setting'}, [el('span', {text: '面板主题'}), theme]),
      el('label', {class: 'setting'}, [el('span', {text: '角色外观'}), visualStyle]),
      el('p', {class: 'muted', text: '星空画室是 12 种静态姿态，首次选择后加载约 2.7 MB。'}),
      settingsRow('靠近时看向鼠标', 'gaze'), settingsRow('启用互动', 'interaction'), settingsRow('提示音（默认关闭）', 'sound'), settingsRow('减少动态', 'reducedMotion'), settingsRow('季节小饰物', 'seasonal'), settingsRow('输入节奏反馈（只计次数）', 'inputFeedback'),
      el('p', {class: 'muted', text: '输入反馈默认关闭。开启后只在本页统计按键次数，不读取按键名称、内容或输入框文字；停笔后归于安静。'}),
      el('div', {class: 'row'}, [button('玩一小会儿', () => startGame()), button('导出偏好', () => downloadPreferences())]),
      importFile, status, el('div', {class: 'row'}, [el('a', {class: 'link', href: 'andromeda-pet://open?target=companion', text: '回桌面陪伴'}), link('还没安装？下载桌宠', SITE_CONTENT.links.releases), link('反馈问题', SITE_CONTENT.links.issues)]),
      el('p', {class: 'muted', text: '点击后由浏览器请求打开桌宠。这里不检测是否安装；未安装时可用旁边的下载入口。'}),
      el('p', {class: 'muted', text: '公开向导 · 无账号服务 · 无自动跨端同步'})
    );
    place(); updateReading(); pumpEvents(); close.focus({preventScroll: true});
  }
  function downloadPreferences() {
    const blob = new Blob([JSON.stringify(exportWebPreferences(preferences), null, 2)], {type: 'application/json'}), url = URL.createObjectURL(blob);
    const anchor = el('a', {href: url, download: 'andromeda-preferences.json'}); root.append(anchor); anchor.click(); anchor.remove(); later(() => URL.revokeObjectURL(url), 1000);
  }
  function startGame() {
    if (!preferences.interaction) return;
    gameActive = true; let score = 0;
    const result = el('p', {class: 'muted', text: '收集 5 颗星星，放松一下。随时可以结束。'}), star = button('✦', () => {
      if (!gameActive) return; score += 1; result.textContent = `收集了 ${score} / 5 颗星星`;
      star.style.transform = reduced() ? '' : `translateX(${Math.round(Math.random() * 120 - 60)}px)`;
      if (score >= 5) { gameActive = false; star.disabled = true; result.textContent = '星星收好了。带着一点轻松，继续今天的事情吧。'; interaction('play'); }
    }); star.className = 'star'; star.setAttribute('aria-label', '收集一颗星星');
    panel.replaceChildren(el('h2', {text: '给自己一个小休息'}), result, el('div', {class: 'game'}, [star]), button('回到向导', open)); star.focus();
  }
  function endTour() { tourIndex = -1; highlight.hidden = true; }
  function targetForStep() { try { return doc.querySelector(options.tour?.[tourIndex]?.selector); } catch { return null; } }
  function positionHighlight() {
    if (tourIndex < 0) return; const target = targetForStep();
    if (!target?.isConnected) { highlight.hidden = true; return; }
    const rect = target.getBoundingClientRect(); highlight.hidden = !rect.width || !rect.height;
    Object.assign(highlight.style, {left: `${rect.left - 5}px`, top: `${rect.top - 5}px`, width: `${rect.width + 10}px`, height: `${rect.height + 10}px`});
  }
  function startTour(index = 0) {
    if (suspended() || !Array.isArray(options.tour)) return;
    tourIndex = index;
    if (tourIndex >= options.tour.length) { endTour(); open(); return; }
    const step = options.tour[tourIndex], target = targetForStep();
    const message = el('p', {text: cleanText(step.text, 360)});
    panelOpen = true; panel.hidden = false;
    panel.replaceChildren(el('span', {class: 'eyebrow', text: `一起逛逛 / ${tourIndex + 1} OF ${options.tour.length}`}), el('h2', {text: cleanText(step.title, 70)}), message,
      el('p', {class: 'muted', text: target ? '高亮区域就是这一站。你仍然可以操作页面。' : '这个入口暂时不在当前页面，可以跳到下一站。'}),
      el('div', {class: 'row'}, [button(index === options.tour.length - 1 ? '完成导览' : '下一站', () => startTour(index + 1), true), button('结束导览', () => { endTour(); open(); })]));
    target?.scrollIntoView({behavior: reduced() ? 'instant' : 'smooth', block: 'center'}); positionHighlight(); later(positionHighlight, 350); place();
  }
  function syncSession() {
    let session = null; try { session = options.getSession?.(); } catch { /* No inferred authentication. */ }
    const user = session?.authenticated === true ? cleanText(session.userId, 128) : null;
    if (user !== sessionUser) { sessionUser = user; engine = createCompanionEngine({}, {role: user ? 'owner' : 'visitor', timezoneOffsetMinutes: -new Date().getTimezoneOffset()}); scheduler.clear(); shownEvent = null; hideBubble(); }
    return session;
  }
  function receiveTask(event) {
    if (destroyed) return false;
    const command = acceptTaskEvent(event, syncSession()); if (!command) return false;
    try { const result = engine.dispatch(command); handleEvents(result); return true; } catch { return false; }
  }
  function moveFromPixels(left, top, dock = null) {
    layoutOverride = false;
    const view = viewport(), dimensions = size();
    update({dock, x: (left - view.left - 16) / Math.max(1, view.width - dimensions.width - 32), y: (top - view.top - 16) / Math.max(1, view.height - dimensions.height - 32)});
  }
  listen(canvas, 'pointerdown', event => {
    if (event.button !== 0 || suspended() || !opaqueAt(event)) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: parseFloat(pet.style.left), top: parseFloat(pet.style.top), moved: false};
    canvas.setPointerCapture(event.pointerId); cancel(dockTimer);
  });
  listen(canvas, 'pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true; stopAnimation(); closePanel(false); hideBubble();
    const view = viewport(), dimensions = size();
    pet.style.left = `${Math.max(view.left, Math.min(view.left + view.width - dimensions.width, drag.left + dx))}px`;
    pet.style.top = `${Math.max(view.top, Math.min(view.top + view.height - dimensions.height, drag.top + dy))}px`;
  });
  const finishDrag = (event, cancelled = false) => {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved; drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!moved) return;
    suppressClick = true; later(() => { suppressClick = false; }, 0);
    const left = parseFloat(pet.style.left), top = parseFloat(pet.style.top), view = viewport();
    const dock = cancelled ? null : left <= view.left + 24 ? 'left' : left + size().width >= view.left + view.width - 24 ? 'right' : null;
    moveFromPixels(left, top, dock); if (dock) dockTimer = later(() => update({collapsed: true}), 700);
  };
  listen(canvas, 'pointerup', event => finishDrag(event)); listen(canvas, 'pointercancel', event => finishDrag(event, true)); listen(canvas, 'lostpointercapture', event => finishDrag(event, true));
  listen(canvas, 'click', event => { if (!suppressClick && (event.detail === 0 || opaqueAt(event))) panelOpen ? closePanel() : open(); });
  listen(canvas, 'keydown', event => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); panelOpen ? closePanel() : open(); }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const change = event.shiftKey ? 40 : 16; moveFromPixels(parseFloat(pet.style.left) + (event.key === 'ArrowLeft' ? -change : event.key === 'ArrowRight' ? change : 0), parseFloat(pet.style.top) + (event.key === 'ArrowUp' ? -change : event.key === 'ArrowDown' ? change : 0)); }
  });
  listen(restore, 'click', () => { if (autoAvoid) return; if (layoutCollapsed) layoutOverride = true; update({collapsed: false, dock: null}); open(); });
  listen(bubbleClose, 'click', hideBubble);
  listen(doc, 'keydown', event => { if (event.composedPath().includes(host) && event.key === 'Escape') { event.preventDefault(); panelOpen ? closePanel() : update({collapsed: true}); } });
  listen(doc, 'pointerdown', event => { if (panelOpen && !event.composedPath().includes(host)) closePanel(false); });
  listen(doc, 'pointermove', event => {
    if (event.pointerType !== 'mouse' || !preferences.gaze || preferences.visualStyle === 'studio' || reduced() || suspended() || action || drag || panelOpen || !atlas || !manifest?.lookDirections) return;
    const rect = canvas.getBoundingClientRect(), dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2, distance = Math.hypot(dx, dy);
    if (distance > 260 || distance < 24) { draw(); return; }
    const cell = nearestLookCell(manifest.lookDirections, manifest.atlas.columns, dx, dy);
    if (cell) draw(cell.row, cell.column);
  }, {passive: true});
  const playingMedia = new Set();
  const checkInput = () => {
    const focused = doc.activeElement;
    const next = playingMedia.size > 0 || (!!focused && focused !== host && (focused.matches?.('iframe,input:not([type=button]):not([type=submit]),textarea,select,[contenteditable]:not([contenteditable=false])') || focused.isContentEditable));
    if (next !== autoAvoid) { autoAvoid = next; renderState(); }
  };
  // Deliberately receives no event: the feedback never reads key, code, data,
  // target.value, clipboard or IME content. Only a local aggregate is retained.
  listen(doc, 'keydown', () => {
    if (!preferences.inputFeedback || doc.hidden || doc.fullscreenElement || preferences.collapsed) return;
    const focused = doc.activeElement;
    if (!focused || focused === host || !(focused.matches?.('input:not([type=button]):not([type=submit]),textarea,[contenteditable]:not([contenteditable=false])') || focused.isContentEditable)) return;
    typingCount += 1; typingActive = true; cancel(typingIdleTimer);
    if (typingPaintTimer === undefined) typingPaintTimer = later(paintTyping, 200);
    typingIdleTimer = later(stopTyping, 1400);
  });
  listen(doc, 'focusin', checkInput); listen(doc, 'focusout', () => later(checkInput, 0));
  listen(win, 'blur', () => later(checkInput, 0));
  listen(win, 'focus', () => later(checkInput, 0));
  listen(doc, 'pointerup', () => later(checkInput, 0));
  listen(doc, 'play', event => { if (event.target?.tagName === 'VIDEO') { playingMedia.add(event.target); checkInput(); } }, {capture: true});
  for (const type of ['pause', 'ended', 'emptied']) listen(doc, type, event => { playingMedia.delete(event.target); checkInput(); }, {capture: true});
  listen(doc, 'visibilitychange', () => { syncSession(); renderState(); if (doc.hidden) audioContext?.suspend().catch(() => {}); });
  listen(doc, 'fullscreenchange', renderState); listen(win, 'resize', () => { layoutOverride = false; place(); }); listen(win, 'scroll', () => { positionHighlight(); if (preferences.readingRewards && readingTimer === undefined) updateReading(); if (avoidSelectors.length && layoutTimer === undefined) layoutTimer = later(() => { layoutTimer = undefined; place(); }, 80); }, {passive: true});
  if (avoidSelectors.length && win.ResizeObserver) { layoutObserver = new win.ResizeObserver(() => place()); layoutObserver.observe(doc.body); }
  if (avoidSelectors.length) listen(doc, 'load', place, {capture: true});
  if (avoidSelectors.length) for (const type of ['transitionend', 'animationend']) listen(doc, type, place, {capture: true});
  if (win.visualViewport) { listen(win.visualViewport, 'resize', place); listen(win.visualViewport, 'scroll', place); }
  listen(reducedMedia, 'change', renderState);
  listen(poster, 'load', () => { posterLoaded = true; fallback.hidden = true; }); listen(poster, 'error', () => { poster.hidden = true; fallback.hidden = false; });
  async function loadImage(url, image = new win.Image()) {
    const safe = sameOriginAsset(url, import.meta.url, win.location.origin);
    const requestSignal = win.AbortSignal.any ? win.AbortSignal.any([signal, win.AbortSignal.timeout(15000)]) : signal;
    const response = await win.fetch(safe, {signal: requestSignal, redirect: 'error', credentials: 'same-origin'});
    if (!response.ok) throw new Error('角色图片请求失败');
    const blob = await response.blob(); if (blob.size > 32 * 1024 * 1024) throw new Error('角色图片超过 32 MB');
    const objectUrl = win.URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
    if (signal.aborted) { win.URL.revokeObjectURL(objectUrl); reject(new DOMException('Aborted', 'AbortError')); return; }
    let timeout;
    const cleanup = () => { cancel(timeout); image.onload = image.onerror = null; signal.removeEventListener('abort', stopped); win.URL.revokeObjectURL(objectUrl); };
    const stopped = () => { cleanup(); image.src = ''; reject(new DOMException('Aborted', 'AbortError')); };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('角色图集加载失败')); };
    timeout = later(() => { cleanup(); image.src = ''; reject(new Error('角色图集加载超时')); }, 15000);
    signal.addEventListener('abort', stopped, {once: true}); image.src = objectUrl;
  }); }
  const ready = (async () => {
    try {
      if (resourceError) throw resourceError;
      const requestSignal = win.AbortSignal.any ? win.AbortSignal.any([signal, win.AbortSignal.timeout(15000)]) : signal;
      const response = await win.fetch(manifestUrl, {signal: requestSignal, redirect: 'error', credentials: 'same-origin'}); if (!response.ok) throw new Error('角色清单加载失败');
      const data = await response.json();
      const prepared = prepareWebCharacter(data, manifestUrl, win.location.origin);
      if (prepared.legacy) loadImage(new URL('neutral.png', manifestUrl), poster).then(() => { if (!atlas && !destroyed) poster.hidden = false; }).catch(() => {});
      const loaded = await loadImage(prepared.imageUrl);
      if (loaded.naturalWidth !== prepared.pack.atlas.width || loaded.naturalHeight !== prepared.pack.atlas.height) throw new Error('角色图集尺寸不匹配');
      if (destroyed) return; manifest = prepared.manifest; pack = prepared.pack; atlas = loaded;
      canvas.width = pack.atlas.cellWidth; canvas.height = pack.atlas.cellHeight; canvas.dataset.characterId = pack.id;
      canvas.dataset.assetState = 'ready'; place(); draw(); scheduleIdle();
    } catch (error) { if (!destroyed) { canvas.dataset.assetState = 'fallback'; options.onError?.({code: 'ASSET_UNAVAILABLE', message: error.message}); } }
  })();
  renderState();
  return Object.freeze({
    ready, open, play, say, receiveTask, refreshSession: syncSession,
    collapse: () => update({collapsed: true}), restore: () => update({collapsed: false, dock: null}),
    getPreferences: () => ({...preferences}), exportPreferences: () => exportWebPreferences(preferences),
    importPreferences: data => { preferences = importWebPreferences(data, preferences); save(); renderState(); return exportWebPreferences(preferences); },
    destroy() { if (destroyed) return; destroyed = true; abort.abort(); layoutObserver?.disconnect(); for (const timer of activeTimers) win.clearTimeout(timer); activeTimers.clear(); audioContext?.close().catch(() => {}); host.remove(); atlas = manifest = null; },
  });
}
