import { GaplessEngine } from './engine.js';

const $ = s => document.querySelector(s);
const fmt = t => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
const settings = Object.assign({ mode: 'gapless', crossfade: 6, mediaEl: true }, JSON.parse(localStorage.getItem('tp-settings') || '{}'));
const save = () => localStorage.setItem('tp-settings', JSON.stringify(settings));

let ctx, engine, audioEl;
let library = [], albums = [], queue = [], qi = -1;
let curVoice = null, nextVoice = null, gen = 0, playing = false, view = { type: 'albums' };

function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  let out = ctx.destination;
  if (settings.mediaEl) {
    // 经 <audio> 元素输出：让浏览器把本页识别为“正在播放媒体”，Media Session / 方向盘按键才有机会生效
    const dest = ctx.createMediaStreamDestination();
    audioEl = $('#sink'); audioEl.srcObject = dest.stream; audioEl.play().catch(() => {});
    out = dest;
  }
  engine = new GaplessEngine(ctx, out);
  applySettings();
  window.__engine = engine; window.__ctx = ctx;
}
function applySettings() {
  if (!engine) return;
  engine.gaplessOnly = settings.mode === 'gapless';
  engine.crossfade = settings.crossfade;
}
const url = t => 'music/' + t.file.split('/').map(encodeURIComponent).join('/');

// ---------- 播放控制 ----------
async function playIndex(i, seek = 0) {
  if (i < 0 || i >= queue.length) return stop();
  ensureAudio();
  const my = ++gen;
  engine.stopAll(); curVoice = nextVoice = null; qi = i;
  render(); setStatus('加载中…');
  if (ctx.state !== 'running') await ctx.resume();
  if (audioEl) audioEl.play().catch(() => {});
  let buf;
  try { buf = await engine.load(url(queue[i])); } catch (e) { setStatus('加载失败：' + e.message); return; }
  if (my !== gen) return;
  curVoice = engine.schedule(queue[i], buf, ctx.currentTime + 0.05, seek);
  hookEnd(curVoice, my);
  playing = true; setStatus(''); render(); updateMediaSession();
  prepareNext(my);
}

function hookEnd(voice, my) {
  voice.src.addEventListener('ended', () => { if (my === gen && voice === curVoice && !nextVoice) stop(); });
}

async function prepareNext(my) {
  const ni = qi + 1;
  if (!curVoice || ni >= queue.length) return;
  const t = queue[ni], base = curVoice;
  engine.prune([url(queue[qi]), url(t)]);
  let buf;
  try { buf = await engine.load(url(t)); } catch (e) { return; }
  if (my !== gen || curVoice !== base || nextVoice) return;
  if (base.end - ctx.currentTime < 0.05) return; // 来不及了（极端情况），交给 ended 处理
  nextVoice = engine.scheduleAfter(base, t, buf);
  nextVoice.qi = ni;
  hookEnd(nextVoice, my);
  // 音频时钟上的“切换标记”：在下一首开始时触发 ended 事件，不依赖可能被限流的 JS 定时器
  const marker = ctx.createConstantSource(); const g = ctx.createGain(); g.gain.value = 0;
  marker.connect(g).connect(engine.master);
  marker.start(); marker.stop(nextVoice.when);
  marker.onended = () => promote(my);
}

function promote(my) {
  if (my !== gen || !nextVoice) return;
  curVoice = nextVoice; nextVoice = null; qi = curVoice.qi;
  render(); updateMediaSession(); prepareNext(my);
}

// 设置改变后，重新安排已调度的下一首（例如拖动交叉淡入滑块）
async function rescheduleNext() {
  applySettings();
  if (!nextVoice || !curVoice) return;
  if (nextVoice.when <= ctx.currentTime + 0.2) return; // 已在切换中，不打断
  const nv = nextVoice; nextVoice = null;
  try { nv.src.onended = null; nv.src.stop(); } catch (e) {}
  engine.voices = engine.voices.filter(v => v !== nv);
  const g = curVoice.gain.gain; g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(1, ctx.currentTime);
  const my = ++gen;
  hookEnd(curVoice, my);
  prepareNext(my);
}

function togglePlay() {
  if (!ctx || qi < 0) { if (!queue.length) setQueue(library, 0); return playIndex(qi < 0 ? 0 : qi); }
  if (!curVoice) return playIndex(qi);
  if (ctx.state === 'running') { ctx.suspend(); playing = false; } else { ctx.resume(); audioEl && audioEl.play().catch(() => {}); playing = true; }
  render(); updateMediaSession();
}
function next() { if (qi + 1 < queue.length) playIndex(qi + 1); }
function prev() { if (curVoice && engine.position(curVoice) > 3) playIndex(qi); else playIndex(Math.max(qi - 1, 0)); }
function seek(t) { if (qi >= 0) playIndex(qi, t); }
function stop() { gen++; engine && engine.stopAll(); curVoice = nextVoice = null; playing = false; render(); updateMediaSession(); }
function setQueue(list, i) { queue = list.slice(); qi = i; }

// ---------- Media Session ----------
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = queue[qi];
  if (t) navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
    artwork: t.cover ? [{ src: 'music/' + t.cover, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
  h('play', () => { if (!playing) togglePlay(); });
  h('pause', () => { if (playing) togglePlay(); });
  h('previoustrack', prev); h('nexttrack', next);
  h('seekto', d => seek(d.seekTime));
  h('seekbackward', d => curVoice && seek(Math.max(engine.position(curVoice) - (d.seekOffset || 10), 0)));
  h('seekforward', d => curVoice && seek(engine.position(curVoice) + (d.seekOffset || 10)));
}

// ---------- 界面 ----------
function setStatus(s) { $('#status').textContent = s; }
function render() {
  const t = queue[qi];
  $('#np-title').textContent = t ? t.title : '未在播放';
  $('#np-sub').textContent = t ? `${t.artist} · ${t.album}` : '选择一张专辑开始';
  $('#np-cover').src = t && t.cover ? 'music/' + t.cover : 'icons/icon-512.png';
  $('#btn-play').textContent = playing ? '⏸' : '▶';
  $('#btn-play').setAttribute('aria-label', playing ? '暂停' : '播放');
  const list = $('#list'); list.innerHTML = '';
  if (view.type === 'albums') {
    $('#view-title').textContent = '专辑';
    $('#btn-back').hidden = true;
    for (const a of albums) {
      const el = document.createElement('button'); el.className = 'album';
      el.innerHTML = `<img src="${a.cover ? 'music/' + a.cover : 'icons/icon-512.png'}" alt=""><div><b></b><span></span></div>`;
      el.querySelector('b').textContent = a.name;
      el.querySelector('span').textContent = `${a.artist} · ${a.tracks.length} 首`;
      el.onclick = () => { view = { type: 'album', album: a }; render(); };
      list.appendChild(el);
    }
  } else {
    const a = view.album;
    $('#view-title').textContent = a.name; $('#btn-back').hidden = false;
    const all = document.createElement('button'); all.className = 'track playall'; all.textContent = '▶ 播放整张专辑';
    all.onclick = () => { setQueue(a.tracks, 0); playIndex(0); }; list.appendChild(all);
    a.tracks.forEach((tr, i) => {
      const el = document.createElement('button');
      el.className = 'track' + (t === tr ? ' on' : '');
      el.innerHTML = `<i>${tr.track || i + 1}</i><b></b><span>${fmt(tr.duration)}</span>`;
      el.querySelector('b').textContent = tr.title;
      el.onclick = () => { setQueue(a.tracks, i); playIndex(i); };
      list.appendChild(el);
    });
  }
  $('#mode-gapless').classList.toggle('on', settings.mode === 'gapless');
  $('#mode-xf').classList.toggle('on', settings.mode === 'crossfade');
  $('#xf').disabled = settings.mode !== 'crossfade';
  $('#xf').value = settings.crossfade; $('#xf-val').textContent = settings.crossfade + ' 秒';
}

let dragging = false;
function tickUI() {
  if (engine && curVoice && !dragging) {
    const p = engine.position(curVoice), d = curVoice.trackDur;
    $('#seek').max = d; $('#seek').value = p;
    $('#t-cur').textContent = fmt(p); $('#t-dur').textContent = fmt(d);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && playing) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: 1 }); } catch (e) {}
    }
  }
  requestAnimationFrame(tickUI);
}

async function init() {
  const r = await fetch('music/library.json', { cache: 'no-cache' });
  library = (await r.json()).tracks;
  const map = new Map();
  for (const t of library) {
    if (!map.has(t.album)) map.set(t.album, { name: t.album, artist: t.artist, cover: t.cover, tracks: [] });
    map.get(t.album).tracks.push(t);
  }
  albums = [...map.values()];
  $('#btn-play').onclick = togglePlay; $('#btn-next').onclick = next; $('#btn-prev').onclick = prev;
  $('#btn-back').onclick = () => { view = { type: 'albums' }; render(); };
  const sk = $('#seek');
  sk.oninput = () => { dragging = true; $('#t-cur').textContent = fmt(+sk.value); };
  sk.onchange = () => { dragging = false; seek(+sk.value); };
  $('#mode-gapless').onclick = () => { settings.mode = 'gapless'; save(); render(); rescheduleNext(); };
  $('#mode-xf').onclick = () => { settings.mode = 'crossfade'; save(); render(); rescheduleNext(); };
  $('#xf').oninput = e => { settings.crossfade = +e.target.value; $('#xf-val').textContent = settings.crossfade + ' 秒'; };
  $('#xf').onchange = () => { save(); rescheduleNext(); };
  $('#me').checked = settings.mediaEl;
  $('#me').onchange = e => { settings.mediaEl = e.target.checked; save(); location.reload(); };
  $('#btn-cache').onclick = cacheAll;
  render(); tickUI();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function cacheAll() {
  if (!('caches' in window)) return setStatus('此浏览器不支持离线缓存');
  const c = await caches.open('tp-music-v1'); let n = 0;
  for (const t of library) {
    setStatus(`离线缓存中 ${++n}/${library.length}…`);
    try { if (!(await c.match(url(t)))) await c.add(url(t)); } catch (e) { setStatus('缓存失败：' + t.title); return; }
  }
  setStatus('已全部缓存，可离线播放');
}

init().catch(e => setStatus('初始化失败：' + e.message));
window.__player = { playIndex, next, prev, seek, togglePlay, setQueue, get state() { return { qi, playing, curVoice, nextVoice, queue }; }, get library() { return library; }, settings, rescheduleNext };
