export const MAX_AMBIENCE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/iu;
const MIME_TYPES = new Set(['', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'application/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/webm', 'audio/opus']);

/** Local files only. The host receives a scalar level, never a filename or audio samples. */
export function mountAmbience({ root, onLevel = () => {} } = {}) {
  const document = root?.ownerDocument, view = document?.defaultView;
  if (!document || !view || typeof root.appendChild !== 'function' || typeof onLevel !== 'function')
    throw new TypeError('A local ambience root and level callback are required');
  const listeners = [];
  const listen = (target, type, callback) => {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  };
  const element = (tag, text, role) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (role) node.dataset.ambience = role;
    return node;
  };
  const card = element('article', '', 'card'); card.className = 'card';
  const title = element('h2', '本地音乐氛围');
  const description = element('p', '选择本地音频后点击播放。最多20 MiB，音乐与文件名不会上传；星璇只接收轻微律动幅度。');
  const controls = element('div'); controls.className = 'actions';
  const fileLabel = element('label', '选择本地音频'); fileLabel.className = 'file-button';
  fileLabel.tabIndex = 0; fileLabel.setAttribute('role', 'button');
  const fileInput = element('input', '', 'file'); fileInput.type = 'file';
  fileInput.accept = '.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.opus';
  fileInput.setAttribute('aria-label', '选择本地音频'); fileLabel.appendChild(fileInput);
  const playButton = element('button', '播放', 'play'); playButton.type = 'button'; playButton.className = 'primary';
  const pauseButton = element('button', '暂停', 'pause'); pauseButton.type = 'button';
  const stopButton = element('button', '停止', 'stop'); stopButton.type = 'button';
  const volumeLabel = element('label', '音量'); volumeLabel.className = 'inline';
  const volumeInput = element('input', '', 'volume'); volumeInput.type = 'range';
  volumeInput.min = '0'; volumeInput.max = '1'; volumeInput.step = '0.05'; volumeInput.value = '0.35';
  volumeInput.setAttribute('aria-label', '本地音乐音量'); volumeLabel.appendChild(volumeInput);
  const motionLabel = element('label', '减少动作（音乐继续播放）'); motionLabel.className = 'inline';
  const motionInput = element('input', '', 'reduced-motion'); motionInput.type = 'checkbox';
  motionLabel.appendChild(motionInput);
  const statusText = element('p', '', 'status'); statusText.className = 'caption'; statusText.setAttribute('role', 'status');
  for (const node of [fileLabel, playButton, pauseButton, stopButton, volumeLabel, motionLabel]) controls.appendChild(node);
  for (const node of [title, description, controls, statusText]) card.appendChild(node);
  root.appendChild(card);

  const media = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let systemReduced = Boolean(media?.matches), userReduced = false;
  let file = null, context = null, gain = null, analyser = null, source = null, decoded = null;
  let timer = null, generation = 0, offset = 0, startedAt = 0;
  let status = 'idle', message = '尚未选择音频，音乐氛围已关闭。', volume = 0.35, level = 0, destroyed = false;
  const reduced = () => systemReduced || userReduced;
  const snapshot = () => ({ status, hasFile: Boolean(file), volume, reducedMotion: reduced(), level });

  function publishLevel(value, force = false) {
    const next = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    if (!force && next === level) return;
    level = next;
    try { onLevel(next); } catch { /* A host animation error cannot interrupt music controls. */ }
  }
  function clearMeter() {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
    publishLevel(0, true); // Safety resets are immediate even between two ordinary meter samples.
  }
  function render() {
    playButton.disabled = destroyed || !file || status === 'playing' || status === 'loading';
    playButton.textContent = status === 'paused' ? '继续播放' : status === 'loading' ? '准备音频…' : '播放';
    pauseButton.disabled = destroyed || status !== 'playing';
    stopButton.disabled = destroyed || !['playing', 'paused', 'loading'].includes(status);
    motionInput.checked = reduced(); motionInput.disabled = systemReduced || destroyed;
    statusText.textContent = message;
  }
  function disconnect(node) { try { node?.disconnect(); } catch { /* Already disconnected. */ } }
  function stopSource() {
    const previous = source; source = null;
    if (previous) { previous.onended = null; try { previous.stop(); } catch { /* Already ended. */ } disconnect(previous); }
  }
  function release() {
    clearMeter(); stopSource(); disconnect(gain); disconnect(analyser);
    gain = null; analyser = null; decoded = null; offset = 0;
    const previous = context; context = null;
    try { Promise.resolve(previous?.close()).catch(() => {}); } catch { /* Native context already closed. */ }
  }
  function stop() {
    if (destroyed) return snapshot();
    generation += 1; release();
    status = file ? 'stopped' : 'idle'; message = file ? '已停止，可重新点击播放。' : '尚未选择音频，音乐氛围已关闭。';
    render(); return snapshot();
  }
  function meter(token) {
    if (destroyed || status !== 'playing' || token !== generation || reduced()) return;
    timer = view.setTimeout(() => {
      timer = null;
      if (destroyed || status !== 'playing' || token !== generation || reduced()) return;
      try {
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        let energy = 0;
        for (const value of values) energy += Number.isFinite(value) ? value * value : 0;
        const amplitude = volume === 0 ? 0 : Math.min(1, Math.sqrt(energy / values.length) * 2);
        publishLevel(amplitude < 0.003 ? 0 : amplitude);
      } catch { publishLevel(0); }
      meter(token);
    }, 100);
  }
  function startSource(token) {
    if (!gain) {
      gain = context.createGain(); gain.gain.value = volume;
      analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7;
      gain.connect(analyser); analyser.connect(context.destination);
    }
    const playing = context.createBufferSource(); source = playing;
    playing.buffer = decoded; playing.connect(gain);
    playing.onended = () => {
      if (source !== playing || token !== generation || destroyed) return;
      stop(); message = '播放结束，点击播放可以重听。'; render();
    };
    if (offset >= decoded.duration) offset = 0;
    startedAt = context.currentTime;
    playing.start(0, offset);
    status = 'playing'; message = reduced() ? '音乐正在播放，已减少星璇的动作。' : '音乐正在播放，星璇轻轻跟着节奏。';
    render(); if (!reduced()) meter(token);
  }
  async function play() {
    if (destroyed || !file || document.hidden || status === 'playing' || status === 'loading') return;
    const token = ++generation, selected = file;
    const continuing = status === 'paused' && context && decoded;
    status = 'loading'; message = '正在准备本地音频…'; render();
    const current = () => !destroyed && generation === token && file === selected && !document.hidden;
    try {
      if (!continuing) {
        const AudioContext = view.AudioContext || view.webkitAudioContext;
        if (typeof AudioContext !== 'function') throw new Error('Audio unavailable');
        context = new AudioContext();
      }
      const playingContext = context;
      // Resume is invoked directly in the user's click, before awaiting file IO or decoding.
      await playingContext.resume();
      if (!current()) return;
      if (!continuing) {
        const bytes = await selected.arrayBuffer();
        if (!current()) return;
        if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > MAX_AMBIENCE_BYTES)
          throw new Error('Audio too large');
        const buffer = await playingContext.decodeAudioData(bytes);
        if (!current()) return;
        if (!Number.isFinite(buffer?.duration) || buffer.duration <= 0) throw new Error('Empty audio');
        decoded = buffer;
      }
      startSource(token);
    } catch {
      if (!current()) return;
      generation += 1; release(); status = 'error';
      message = '这段音频暂时无法播放，请选择浏览器支持的本地音频文件。'; render();
    }
  }
  function pause() {
    if (destroyed || status !== 'playing') return;
    generation += 1;
    offset = Math.min(decoded.duration, Math.max(0, offset + context.currentTime - startedAt));
    clearMeter(); stopSource();
    try { Promise.resolve(context.suspend()).catch(() => {}); } catch { /* The source is already stopped. */ }
    status = 'paused'; message = '已暂停，再次点击继续播放。'; render();
  }
  function choose() {
    if (destroyed) return;
    stop(); file = null;
    const selected = fileInput.files?.length === 1 ? fileInput.files[0] : null;
    if (!selected) { status = 'idle'; message = '尚未选择音频，音乐氛围已关闭。'; render(); return; }
    if (typeof selected.name !== 'string' || !EXTENSIONS.test(selected.name)
      || !MIME_TYPES.has(String(selected.type || '').toLowerCase()) || !Number.isInteger(selected.size)
      || selected.size <= 0 || selected.size > MAX_AMBIENCE_BYTES || typeof selected.arrayBuffer !== 'function') {
      fileInput.value = ''; status = 'error'; message = '请选择不超过20 MiB的 MP3、WAV、OGG、M4A、AAC、FLAC、WebM 或 Opus 音频。'; render(); return;
    }
    file = selected; status = 'ready'; message = '已选择本地音频，点击播放后开始。'; render();
  }
  function motionChanged() {
    clearMeter();
    if (status === 'playing' && !reduced()) meter(generation);
    if (status === 'playing') message = reduced() ? '音乐正在播放，已减少星璇的动作。' : '音乐正在播放，星璇轻轻跟着节奏。';
    render();
  }
  listen(fileInput, 'change', choose);
  listen(fileLabel, 'keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
  });
  listen(playButton, 'click', () => { void play(); });
  listen(pauseButton, 'click', pause);
  listen(stopButton, 'click', stop);
  listen(volumeInput, 'input', () => {
    const next = Number(volumeInput.value);
    if (!Number.isFinite(next)) return;
    volume = Math.max(0, Math.min(1, next)); if (gain) gain.gain.value = volume;
    if (volume === 0) publishLevel(0, true);
  });
  listen(motionInput, 'change', () => { userReduced = motionInput.checked; motionChanged(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) stop(); });
  listen(view, 'pagehide', stop);
  const onSystemMotion = event => { systemReduced = Boolean(event.matches); motionChanged(); };
  if (media?.addEventListener) listen(media, 'change', onSystemMotion);
  else if (media?.addListener) { media.addListener(onSystemMotion); listeners.push(() => media.removeListener(onSystemMotion)); }
  function destroy() {
    if (destroyed) return;
    stop(); destroyed = true; status = 'destroyed'; file = null; fileInput.value = '';
    for (const remove of listeners) remove();
    card.remove();
  }
  render(); publishLevel(0, true);
  return Object.freeze({ destroy, stop, snapshot });
}
