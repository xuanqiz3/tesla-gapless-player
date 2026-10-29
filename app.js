import { GaplessEngine } from './engine.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = t => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
const trackKey = t => t && t.file;

const settings = Object.assign({
  mode: 'gapless', crossfade: 6, mediaEl: false,
  repeat: 'off', shuffle: false, volume: 1, muted: false, keepAlive: true,
}, JSON.parse(localStorage.getItem('tp-settings') || '{}'));
// 车机优先：旧版默认 mediaEl=true 可能导致 MediaStream 无声，强制纠正一次
if (!localStorage.getItem('tp-mediael-v2')) {
  settings.mediaEl = false;
  localStorage.setItem('tp-mediael-v2', '1');
  localStorage.setItem('tp-settings', JSON.stringify(settings));
}
const save = () => localStorage.setItem('tp-settings', JSON.stringify(settings));

function loadList(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
let favorites = new Set(loadList('tp-favorites'));
let recent = loadList('tp-recent');
const saveFav = () => localStorage.setItem('tp-favorites', JSON.stringify([...favorites]));
const saveRecent = () => localStorage.setItem('tp-recent', JSON.stringify(recent.slice(0, 20)));

let ctx, engine, audioEl;
let library = [], albums = [], artists = [];
let queue = [], qi = -1, originalQueue = null;
let curVoice = null, nextVoice = null, gen = 0, playing = false;
let view = { type: 'albums' }; // albums | album | songs | artists | artist | favorites | recent | search
let searchQ = '';
let sleepTimer = null, sleepUntil = 0, sleepTick = null;
let showQueue = false, showSleep = false, sheetOpen = false;
let wantPlay = false;          // 用户意图：正在播放（用于后台被挂起后自动恢复）
let normalGapTimer = null;     // 「普通（有间隙）」模式的演示间隙定时器
const NORMAL_GAP = 0.3;        // 普通模式演示间隙（秒），仅用于对比
const bg = { keepEl: null, wakeLock: null, resumeTries: 0, autoResumes: 0, lastState: '', events: [] };
const bgLog = e => { bg.events.push(`${new Date().toTimeString().slice(0, 8)} ${e}`); if (bg.events.length > 30) bg.events.shift(); };

function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  let out = ctx.destination;
  if (settings.mediaEl) {
    try {
      const dest = ctx.createMediaStreamDestination();
      audioEl = $('#sink'); audioEl.srcObject = dest.stream;
      audioEl.play().catch(err => setStatus('媒体元素播放失败，可关掉「经媒体元素输出」：' + (err && err.message || err)));
      out = dest;
    } catch (e) {
      setStatus('MediaStream 不可用，已回退直连扬声器：' + (e.message || e));
      settings.mediaEl = false; save();
      out = ctx.destination; audioEl = null;
    }
  }
  engine = new GaplessEngine(ctx, out);
  ctx.onstatechange = onCtxState;
  applySettings();
  window.__engine = engine; window.__ctx = ctx;
}
function openSheet(open = true) {
  sheetOpen = !!open;
  $('#now').classList.toggle('open', sheetOpen);
  $('#sheet-bg').classList.toggle('open', sheetOpen);
  $('#now').setAttribute('aria-hidden', sheetOpen ? 'false' : 'true');
  $('#sheet-bg').setAttribute('aria-hidden', sheetOpen ? 'false' : 'true');
}
function applySettings() {
  if (!engine) return;
  engine.gaplessOnly = settings.mode !== 'crossfade';
  engine.crossfade = settings.crossfade;
  engine.setVolume(settings.muted ? 0 : settings.volume);
}
const url = t => 'music/' + t.file.split('/').map(encodeURIComponent).join('/');

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setQueue(list, i, { rememberOriginal = true } = {}) {
  const base = list.slice();
  if (settings.shuffle) {
    if (rememberOriginal) originalQueue = base.slice();
    const cur = base[i];
    const rest = base.filter((_, idx) => idx !== i);
    queue = cur ? [cur, ...shuffleArray(rest)] : shuffleArray(rest);
    qi = cur ? 0 : -1;
  } else {
    originalQueue = null;
    queue = base;
    qi = i;
  }
}

function toggleShuffle() {
  const cur = queue[qi];
  if (!settings.shuffle) {
    settings.shuffle = true;
    originalQueue = queue.slice();
    if (cur) {
      const rest = queue.filter((_, idx) => idx !== qi);
      queue = [cur, ...shuffleArray(rest)];
      qi = 0;
    } else {
      queue = shuffleArray(queue);
    }
  } else {
    settings.shuffle = false;
    if (originalQueue) {
      queue = originalQueue.slice();
      originalQueue = null;
      qi = cur ? queue.findIndex(t => trackKey(t) === trackKey(cur)) : -1;
      if (qi < 0 && cur) { queue = [cur, ...queue]; qi = 0; }
    }
  }
  save(); render(); rescheduleNext();
}

function cycleRepeat() {
  settings.repeat = settings.repeat === 'off' ? 'all' : settings.repeat === 'all' ? 'one' : 'off';
  save(); render(); rescheduleNext();
}

function nextIndex() {
  if (!queue.length || qi < 0) return -1;
  if (settings.repeat === 'one') return qi;
  if (qi + 1 < queue.length) return qi + 1;
  if (settings.repeat === 'all') return 0;
  return -1;
}
function prevIndex() {
  if (!queue.length || qi < 0) return -1;
  if (qi - 1 >= 0) return qi - 1;
  if (settings.repeat === 'all') return queue.length - 1;
  return 0;
}

function pushRecent(t) {
  if (!t) return;
  const k = trackKey(t);
  recent = [k, ...recent.filter(x => x !== k)].slice(0, 20);
  saveRecent();
}

// ---------- 播放控制 ----------
async function playIndex(i, seek = 0) {
  if (i < 0 || i >= queue.length) return stop();
  ensureAudio();
  const my = ++gen;
  if (normalGapTimer) { clearTimeout(normalGapTimer); normalGapTimer = null; }
  engine.stopAll(); curVoice = nextVoice = null; qi = i;
  wantPlay = true;
  keepAliveStart();            // 必须在用户手势的同步阶段启动，之后的 await 会丢失手势
  requestWake();
  pushRecent(queue[i]);
  render(); setStatus('加载中…');
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  if (audioEl) audioEl.play().catch(() => {});
  let buf;
  const trackUrl = url(queue[i]);
  try {
    buf = await engine.load(trackUrl);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    setStatus(`加载失败：${queue[i].title} — ${msg}（${trackUrl}）`);
    console.error('load failed', trackUrl, e);
    return;
  }
  if (my !== gen) return;
  curVoice = engine.schedule(queue[i], buf, ctx.currentTime + 0.05, seek);
  hookEnd(curVoice, my);
  playing = true; setStatus(''); render(); updateMediaSession();
  prepareNext(my);
}

function hookEnd(voice, my) {
  voice.src.addEventListener('ended', () => {
    if (my !== gen || voice !== curVoice || nextVoice) return;
    const ni = nextIndex();
    if (ni < 0) return stop();
    if (settings.mode === 'normal') {
      // 普通播放器行为（对比用）：上一首结束后才开始加载下一首，并固定插入演示间隙
      curVoice = null; render();
      setStatus(`普通模式：曲间演示间隙 ${NORMAL_GAP} 秒（对比用）`);
      normalGapTimer = setTimeout(() => { normalGapTimer = null; if (my === gen) playIndex(ni); }, NORMAL_GAP * 1000);
    } else playIndex(ni);
  });
}

async function prepareNext(my) {
  if (!curVoice) return;
  if (settings.mode === 'normal') return;   // 普通模式不预排队，模拟普通播放器
  let ni;
  if (settings.repeat === 'one') ni = qi;
  else if (qi + 1 < queue.length) ni = qi + 1;
  else if (settings.repeat === 'all' && queue.length) ni = 0;
  else return;
  // 单曲循环：排自己；避免与当前同一 buffer 冲突时仍可重新 schedule
  const t = queue[ni], base = curVoice;
  const keep = [url(queue[qi])];
  if (ni !== qi) keep.push(url(t));
  engine.prune(keep);
  let buf;
  try { buf = await engine.load(url(t)); } catch (e) { return; }
  if (my !== gen || curVoice !== base || nextVoice) return;
  if (base.end - ctx.currentTime < 0.05) return;
  nextVoice = engine.scheduleAfter(base, t, buf);
  nextVoice.qi = ni;
  hookEnd(nextVoice, my);
  const marker = ctx.createConstantSource(); const g = ctx.createGain(); g.gain.value = 0;
  marker.connect(g).connect(engine.master);
  marker.start(); marker.stop(nextVoice.when);
  marker.onended = () => promote(my);
}

function promote(my) {
  if (my !== gen || !nextVoice) return;
  curVoice = nextVoice; nextVoice = null; qi = curVoice.qi;
  pushRecent(queue[qi]);
  render(); updateMediaSession(); prepareNext(my);
}

async function rescheduleNext() {
  applySettings();
  if (!nextVoice || !curVoice) return;
  if (nextVoice.when <= ctx.currentTime + 0.2) return;
  const nv = nextVoice; nextVoice = null;
  try { nv.src.onended = null; nv.src.stop(); } catch (e) {}
  engine.voices = engine.voices.filter(v => v !== nv);
  const g = curVoice.gain.gain; g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(1, ctx.currentTime);
  const my = ++gen;
  hookEnd(curVoice, my);
  prepareNext(my);
}

function togglePlay() {
  if (!ctx || qi < 0) {
    if (!queue.length) setQueue(library, 0);
    return playIndex(qi < 0 ? 0 : qi);
  }
  if (!curVoice) return playIndex(qi);
  if (playing) {
    wantPlay = false; playing = false;
    ctx.suspend(); keepAliveStop(); releaseWake();
  } else {
    wantPlay = true; playing = true;
    keepAliveStart(); requestWake();
    ctx.resume(); audioEl && audioEl.play().catch(() => {});
  }
  render(); updateMediaSession();
}

function next() {
  if (!queue.length) return;
  // 手动下一首：单曲循环也前进到真正的下一首（与网易云/Apple Music 一致）
  let ni;
  if (qi + 1 < queue.length) ni = qi + 1;
  else if (settings.repeat === 'all' || settings.repeat === 'one') ni = 0;
  else return;
  playIndex(ni);
}
function prev() {
  if (!queue.length || qi < 0) return;
  if (curVoice && engine.position(curVoice) > 3) return playIndex(qi);
  const pi = prevIndex();
  if (pi >= 0) playIndex(pi);
}
function seek(t) { if (qi >= 0) playIndex(qi, t); }
function stop() {
  gen++; if (normalGapTimer) { clearTimeout(normalGapTimer); normalGapTimer = null; }
  engine && engine.stopAll(); curVoice = nextVoice = null; playing = false;
  wantPlay = false; keepAliveStop(); releaseWake();
  render(); updateMediaSession();
}

// ---------- 后台播放保活 ----------
// 说明：网页无法保证被系统“杀掉/关闭标签”后继续播放；这里做的是尽量减少被挂起的概率，
// 被挂起后（用户意图仍是播放）自动恢复。
function keepAliveUrl() {
  // 6 秒、8 kHz、8-bit 单声道 WAV，内容为 ±1 级的极低电平抖动（约 -48 dBFS 以下，基本听不到）。
  // 时长 ≥5 秒是因为部分 Chromium 会忽略过短的媒体，不把页面当作“正在播放媒体”。
  const sr = 8000, n = sr * 6, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + (i % 2 ? 1 : -1));
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function keepAliveStart() {
  if (!settings.keepAlive) return;
  if (!bg.keepEl) {
    const el = $('#keepalive');
    el.src = keepAliveUrl(); el.loop = true; el.volume = 1;
    el.addEventListener('pause', () => { if (wantPlay && settings.keepAlive) bgLog('保活音轨被暂停'); });
    bg.keepEl = el;
  }
  if (bg.keepEl.paused) bg.keepEl.play().then(() => bgLog('保活音轨播放中')).catch(e => bgLog('保活音轨无法播放：' + (e && e.name || e)));
}
function keepAliveStop() { if (bg.keepEl && !bg.keepEl.paused) bg.keepEl.pause(); }

async function requestWake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || bg.wakeLock) return;
  try {
    bg.wakeLock = await navigator.wakeLock.request('screen');
    bg.wakeLock.addEventListener('release', () => { bg.wakeLock = null; });
    bgLog('已申请屏幕常亮');
  } catch (e) { bg.wakeLock = null; }   // 不支持或被拒：静默忽略
}
function releaseWake() { if (bg.wakeLock) { bg.wakeLock.release().catch(() => {}); bg.wakeLock = null; } }

function tryResume(reason) {
  if (!ctx || !wantPlay) return;
  if (ctx.state !== 'running' && ctx.state !== 'closed') {
    ctx.resume().then(() => {
      if (ctx.state === 'running') { bg.autoResumes++; bg.resumeTries = 0; bgLog('已自动恢复播放（' + reason + '）'); playing = true; render(); updateMediaSession(); }
    }).catch(() => {});
  }
  if (settings.keepAlive) keepAliveStart();
  if (audioEl && audioEl.paused) audioEl.play().catch(() => {});
}
function onCtxState() {
  bg.lastState = ctx.state; bgLog('AudioContext → ' + ctx.state);
  if (!wantPlay || ctx.state === 'running' || ctx.state === 'closed') { bg.resumeTries = 0; return; }
  // suspended / interrupted 且用户意图仍是播放：被系统挂起，退避重试恢复
  if (bg.resumeTries < 8) {
    const delay = 200 * Math.pow(1.6, bg.resumeTries++);
    setTimeout(() => tryResume('statechange'), delay);
  }
}
document.addEventListener('visibilitychange', () => {
  bgLog('visibility=' + document.visibilityState);
  tryResume('visibilitychange');
  if (document.visibilityState === 'visible' && wantPlay) requestWake();
});
window.addEventListener('pagehide', () => tryResume('pagehide'));
window.addEventListener('pageshow', () => tryResume('pageshow'));
window.addEventListener('focus', () => tryResume('focus'));
document.addEventListener('resume', () => tryResume('lifecycle-resume'));

function playNow(list, i) { setQueue(list, i); playIndex(qi < 0 ? 0 : qi); }

function playNext(track) {
  if (!track) return;
  if (!queue.length || qi < 0) { setQueue([track], 0); return playIndex(0); }
  const insertAt = qi + 1;
  queue.splice(insertAt, 0, track);
  if (originalQueue) {
    const oi = originalQueue.findIndex(t => trackKey(t) === trackKey(queue[qi]));
    originalQueue.splice(oi < 0 ? originalQueue.length : oi + 1, 0, track);
  }
  setStatus('已设为下一首播放'); render(); rescheduleNext();
}

function enqueue(track) {
  if (!track) return;
  if (!queue.length) { setQueue([track], 0); return; }
  queue.push(track);
  if (originalQueue) originalQueue.push(track);
  setStatus('已加入队列'); render();
  if (!nextVoice && playing) rescheduleNext();
}

function clearQueueKeepCurrent() {
  const cur = queue[qi];
  if (!cur) { queue = []; qi = -1; originalQueue = null; stop(); render(); return; }
  queue = [cur]; qi = 0; originalQueue = settings.shuffle ? [cur] : null;
  rescheduleNext(); render();
}

function trimQueueFromCurrent() {
  if (qi < 0) return;
  queue = queue.slice(qi); qi = 0;
  if (originalQueue) {
    const cur = queue[0];
    const oi = originalQueue.findIndex(t => trackKey(t) === trackKey(cur));
    originalQueue = oi >= 0 ? originalQueue.slice(oi) : queue.slice();
  }
  rescheduleNext(); render();
}

function isFav(t) { return t && favorites.has(trackKey(t)); }
function toggleFav(t) {
  if (!t) return;
  const k = trackKey(t);
  if (favorites.has(k)) favorites.delete(k); else favorites.add(k);
  saveFav(); render();
}

function setVolume(v) {
  settings.volume = Math.max(0, Math.min(1, v));
  if (settings.volume > 0) settings.muted = false;
  save(); applySettings(); renderVol();
}
function toggleMute() {
  settings.muted = !settings.muted;
  save(); applySettings(); renderVol();
}
function renderVol() {
  const v = settings.muted ? 0 : settings.volume;
  $('#vol').value = Math.round(settings.volume * 100);
  $('#vol-val').textContent = (settings.muted ? 0 : Math.round(settings.volume * 100)) + '%';
  $('#btn-mute').textContent = settings.muted || v === 0 ? '🔇' : v < 0.4 ? '🔉' : '🔊';
}

function setSleep(minutes) {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  if (sleepTick) { clearInterval(sleepTick); sleepTick = null; }
  sleepUntil = 0;
  if (!minutes) { renderSleep(); setStatus('已关闭睡眠定时'); return; }
  sleepUntil = Date.now() + minutes * 60 * 1000;
  sleepTimer = setTimeout(() => {
    sleepTimer = null; sleepUntil = 0;
    if (playing) togglePlay();
    setStatus('睡眠定时：已暂停');
    renderSleep();
  }, minutes * 60 * 1000);
  sleepTick = setInterval(renderSleep, 1000);
  setStatus(`睡眠定时：${minutes} 分钟后暂停`);
  renderSleep();
}
function renderSleep() {
  $$('#sleep-panel .sleep-opts button').forEach(b => {
    const m = +b.dataset.sleep;
    b.classList.toggle('on', m === 0 ? !sleepUntil : sleepUntil && Math.round((sleepUntil - Date.now()) / 60000) <= m && Math.round((sleepUntil - Date.now()) / 60000) > m - 15 && m > 0);
  });
  // 简化高亮：按剩余分钟最接近的档，或关闭
  const left = sleepUntil ? Math.max(0, sleepUntil - Date.now()) : 0;
  $$('#sleep-panel .sleep-opts button').forEach(b => {
    const m = +b.dataset.sleep;
    if (m === 0) b.classList.toggle('on', !sleepUntil);
    else b.classList.toggle('on', !!sleepUntil && Math.ceil(left / 60000) === m);
  });
  // 若剩余不精确等于档位，高亮最接近的已选档（用 data 标记）
  if (sleepUntil) {
    const minsLeft = Math.ceil(left / 60000);
    let best = null, bestDiff = Infinity;
    $$('#sleep-panel .sleep-opts button').forEach(b => {
      const m = +b.dataset.sleep;
      if (m > 0) {
        b.classList.remove('on');
        const d = Math.abs(m - minsLeft);
        // keep initially selected via closest remaining among 15/30/45/60 — actually show countdown text
      }
    });
    $('#sleep-left').textContent = `剩余 ${fmt(left / 1000)}`;
    // highlight none of fixed buttons except show countdown; mark any button whose value >= remaining as soft — simpler: mark the one user last picked stored on panel
  } else {
    $('#sleep-left').textContent = '';
    $$('#sleep-panel .sleep-opts button').forEach(b => b.classList.toggle('on', +b.dataset.sleep === 0));
  }
  if (sleepUntil && $('#sleep-panel').dataset.picked) {
    $$('#sleep-panel .sleep-opts button').forEach(b => b.classList.toggle('on', b.dataset.sleep === $('#sleep-panel').dataset.picked));
  }
}

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
  h('stop', () => stop());
  h('seekto', d => seek(d.seekTime));
  h('seekbackward', d => curVoice && seek(Math.max(engine.position(curVoice) - (d.seekOffset || 10), 0)));
  h('seekforward', d => curVoice && seek(engine.position(curVoice) + (d.seekOffset || 10)));
}

// ---------- 界面 ----------
function setStatus(s) { $('#status').textContent = s || ''; }

function favTracks() {
  return library.filter(t => favorites.has(trackKey(t)));
}
function recentTracks() {
  const map = new Map(library.map(t => [trackKey(t), t]));
  return recent.map(k => map.get(k)).filter(Boolean);
}
function filteredLibrary() {
  const q = searchQ.trim().toLowerCase();
  if (!q) return null;
  return library.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.artist || '').toLowerCase().includes(q) ||
    (t.album || '').toLowerCase().includes(q)
  );
}

function trackRow(tr, opts = {}) {
  const { indexLabel, listForPlay, playIndexInList } = opts;
  const row = document.createElement('div');
  row.className = 'track-row' + (queue[qi] && trackKey(queue[qi]) === trackKey(tr) ? ' on' : '');
  const main = document.createElement('button');
  main.className = 'track track-main';
  main.innerHTML = `<i></i><b></b><span class="dur"></span>`;
  main.querySelector('i').textContent = indexLabel != null ? indexLabel : '';
  const b = main.querySelector('b');
  b.textContent = tr.title;
  if (opts.showMeta) {
    const m = document.createElement('span'); m.className = 'meta'; m.textContent = `${tr.artist} · ${tr.album}`;
    b.appendChild(document.createElement('br')); b.appendChild(m);
  }
  main.querySelector('.dur').textContent = fmt(tr.duration);
  main.onclick = () => {
    if (listForPlay) playNow(listForPlay, playIndexInList);
    else playNow(library, library.indexOf(tr));
  };
  const acts = document.createElement('div');
  acts.className = 'track-acts';
  const fav = document.createElement('button');
  fav.className = 'fav'; fav.setAttribute('aria-label', '收藏');
  fav.textContent = isFav(tr) ? '♥' : '♡';
  fav.setAttribute('aria-pressed', isFav(tr) ? 'true' : 'false');
  if (isFav(tr)) fav.classList.add('on');
  fav.onclick = e => { e.stopPropagation(); toggleFav(tr); };
  const nbtn = document.createElement('button');
  nbtn.setAttribute('aria-label', '下一首播放'); nbtn.textContent = '下一首';
  nbtn.onclick = e => { e.stopPropagation(); playNext(tr); };
  const qbtn = document.createElement('button');
  qbtn.setAttribute('aria-label', '加入队列'); qbtn.textContent = '队列';
  qbtn.onclick = e => { e.stopPropagation(); enqueue(tr); };
  acts.append(fav, nbtn, qbtn);
  row.append(main, acts);
  return row;
}

function renderQueuePanel() {
  const box = $('#queue-list'); box.innerHTML = '';
  if (!queue.length) {
    box.innerHTML = '<div class="empty">队列为空</div>';
    return;
  }
  queue.forEach((tr, i) => {
    const el = document.createElement('button');
    el.className = 'qitem' + (i === qi ? ' on' : '');
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector('b').textContent = `${i + 1}. ${tr.title}`;
    el.querySelector('span').textContent = tr.artist || '';
    el.onclick = () => playIndex(i);
    box.appendChild(el);
  });
}

const COMPARE_ALBUM = '无缝对比测试';
const MODE_TIPS = {
  gapless: '无缝衔接：下一首提前排在上一首最后一个采样之后，曲间零停顿。',
  crossfade: '交叉淡入淡出：跨专辑时提前叠播并淡入淡出；同专辑连续曲目仍强制无缝。',
  normal: `普通（有间隙）：上一首播完才加载下一首，并固定插入约 ${NORMAL_GAP} 秒静音——仅用于和无缝对比。`,
};
function setMode(m) { settings.mode = m; save(); render(); rescheduleNext(); }
function compareCard(a) {
  const box = document.createElement('div'); box.className = 'compare';
  box.innerHTML = `<b>怎么对比「无缝」开 / 关</b>
    <p>这 3 段是同一段连续音乐，在拍子中间切开。按下面任一按钮，会从第 1 段结尾前 5 秒开始播，约 5 秒后听切点。</p>
    <p>· <b>无缝</b>：节拍和长音一直连着，听不出换曲。<br>· <b>普通（有间隙）</b>：切点处会“咯噔”一下，节拍断约 0.3 秒。</p>
    <div class="cmp-btns"><button data-m="gapless">▶ 无缝模式听切点</button><button data-m="normal">▶ 普通模式听切点</button></div>`;
  box.querySelectorAll('button').forEach(b => b.onclick = () => {
    setMode(b.dataset.m);
    playNow(a.tracks, 0);
    const startAt = Math.max(0, (a.tracks[0].duration || 12) - 5);
    // 等第一段加载完后跳到结尾前 5 秒
    const my = gen; const wait = () => { if (my !== gen) return; if (curVoice) seek(startAt); else setTimeout(wait, 50); };
    setTimeout(wait, 50);
  });
  return box;
}

function render() {
  const t = queue[qi];
  const title = t ? t.title : '未在播放';
  const sub = t ? `${t.artist} · ${t.album}` : '选择一张专辑开始';
  const cover = t && t.cover ? 'music/' + t.cover : 'icons/icon-512.png';
  $('#np-title').textContent = title;
  $('#np-sub').textContent = sub;
  $('#np-cover').src = cover;
  $('#mini-title').textContent = title;
  $('#mini-sub').textContent = t ? sub : '点曲名或「展开」打开完整控制';
  $('#mini-cover').src = cover;
  $('#btn-play').textContent = playing ? '⏸' : '▶';
  $('#btn-play').setAttribute('aria-label', playing ? '暂停' : '播放');
  $('#mini-play').textContent = playing ? '⏸' : '▶';
  $('#mini-play').setAttribute('aria-label', playing ? '暂停' : '播放');
  $('#btn-fav-np').textContent = isFav(t) ? '♥' : '♡';
  $('#btn-fav-np').classList.toggle('on', isFav(t));
  $('#btn-shuffle').classList.toggle('on', !!settings.shuffle);
  const rep = settings.repeat;
  $('#btn-repeat').classList.toggle('on', rep !== 'off');
  $('#btn-repeat').textContent = rep === 'one' ? '🔂' : '🔁';
  $('#btn-repeat').title = rep === 'off' ? '循环：关' : rep === 'all' ? '列表循环' : '单曲循环';

  const list = $('#list'); list.innerHTML = '';
  const results = filteredLibrary();

  if (results) {
    $('#view-title').textContent = `搜索「${searchQ.trim()}」`;
    $('#btn-back').hidden = true;
    if (!results.length) list.innerHTML = '<div class="empty">没有匹配的歌曲</div>';
    else results.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: i + 1, showMeta: true, listForPlay: results, playIndexInList: i })));
  } else if (view.type === 'albums') {
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
  } else if (view.type === 'album') {
    const a = view.album;
    $('#view-title').textContent = a.name; $('#btn-back').hidden = false;
    if (a.name === COMPARE_ALBUM) list.appendChild(compareCard(a));
    const all = document.createElement('button'); all.className = 'playall'; all.textContent = '▶ 播放整张专辑';
    all.onclick = () => { playNow(a.tracks, 0); }; list.appendChild(all);
    a.tracks.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: tr.track || i + 1, listForPlay: a.tracks, playIndexInList: i })));
  } else if (view.type === 'songs') {
    $('#view-title').textContent = '全部歌曲'; $('#btn-back').hidden = true;
    const all = document.createElement('button'); all.className = 'playall'; all.textContent = '▶ 播放全部';
    all.onclick = () => { playNow(library, 0); }; list.appendChild(all);
    library.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: i + 1, showMeta: true, listForPlay: library, playIndexInList: i })));
  } else if (view.type === 'artists') {
    $('#view-title').textContent = '艺人'; $('#btn-back').hidden = true;
    for (const ar of artists) {
      const el = document.createElement('button'); el.className = 'artist-row';
      el.innerHTML = `<b></b><span></span>`;
      el.querySelector('b').textContent = ar.name;
      el.querySelector('span').textContent = `${ar.tracks.length} 首`;
      el.onclick = () => { view = { type: 'artist', artist: ar }; render(); };
      list.appendChild(el);
    }
  } else if (view.type === 'artist') {
    const ar = view.artist;
    $('#view-title').textContent = ar.name; $('#btn-back').hidden = false;
    const all = document.createElement('button'); all.className = 'playall'; all.textContent = '▶ 播放该艺人全部';
    all.onclick = () => { playNow(ar.tracks, 0); }; list.appendChild(all);
    ar.tracks.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: i + 1, showMeta: true, listForPlay: ar.tracks, playIndexInList: i })));
  } else if (view.type === 'favorites') {
    $('#view-title').textContent = '收藏'; $('#btn-back').hidden = true;
    const favs = favTracks();
    if (!favs.length) list.innerHTML = '<div class="empty">还没有收藏，点 ♥ 即可添加</div>';
    else {
      const all = document.createElement('button'); all.className = 'playall'; all.textContent = '▶ 播放收藏';
      all.onclick = () => { playNow(favs, 0); }; list.appendChild(all);
      favs.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: i + 1, showMeta: true, listForPlay: favs, playIndexInList: i })));
    }
  } else if (view.type === 'recent') {
    $('#view-title').textContent = '最近播放'; $('#btn-back').hidden = true;
    const rec = recentTracks();
    if (!rec.length) list.innerHTML = '<div class="empty">暂无最近播放</div>';
    else {
      const all = document.createElement('button'); all.className = 'playall'; all.textContent = '▶ 按最近顺序播放';
      all.onclick = () => { playNow(rec, 0); }; list.appendChild(all);
      rec.forEach((tr, i) => list.appendChild(trackRow(tr, { indexLabel: i + 1, showMeta: true, listForPlay: rec, playIndexInList: i })));
    }
  }

  $('#mode-gapless').classList.toggle('on', settings.mode === 'gapless');
  $('#mode-xf').classList.toggle('on', settings.mode === 'crossfade');
  $('#mode-normal').classList.toggle('on', settings.mode === 'normal');
  $('#mode-tip').textContent = MODE_TIPS[settings.mode] || '';
  $('#xf').disabled = settings.mode !== 'crossfade';
  $('#xf').value = settings.crossfade; $('#xf-val').textContent = settings.crossfade + ' 秒';
  $$('#tabs button').forEach(b => b.classList.toggle('on', !results && (
    (b.dataset.tab === 'albums' && (view.type === 'albums' || view.type === 'album')) ||
    (b.dataset.tab === 'songs' && view.type === 'songs') ||
    (b.dataset.tab === 'artists' && (view.type === 'artists' || view.type === 'artist')) ||
    (b.dataset.tab === 'favorites' && view.type === 'favorites') ||
    (b.dataset.tab === 'recent' && view.type === 'recent')
  )));
  $('#queue-panel').classList.toggle('show', showQueue);
  $('#sleep-panel').classList.toggle('show', showSleep);
  if (showQueue) renderQueuePanel();
  renderVol();
}

let dragging = false;
function tickUI() {
  if (engine && curVoice && !dragging) {
    const p = engine.position(curVoice), d = curVoice.trackDur;
    $('#seek').max = d; $('#seek').value = p;
    $('#t-cur').textContent = fmt(p); $('#t-dur').textContent = fmt(d);
    const pct = d > 0 ? Math.min(100, Math.max(0, p / d * 100)) : 0;
    $('#mini-prog-bar').style.width = pct + '%';
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && playing) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: 1 }); } catch (e) {}
    }
  } else if (!curVoice) {
    $('#mini-prog-bar').style.width = '0%';
  }
  requestAnimationFrame(tickUI);
}

async function init() {
  const r = await fetch('music/library.json', { cache: 'no-cache' });
  library = (await r.json()).tracks;
  const map = new Map();
  const amap = new Map();
  for (const t of library) {
    if (!map.has(t.album)) map.set(t.album, { name: t.album, artist: t.artist, cover: t.cover, tracks: [] });
    map.get(t.album).tracks.push(t);
    if (!amap.has(t.artist)) amap.set(t.artist, { name: t.artist, tracks: [] });
    amap.get(t.artist).tracks.push(t);
  }
  albums = [...map.values()].sort((x, y) => (y.name === COMPARE_ALBUM) - (x.name === COMPARE_ALBUM));
  artists = [...amap.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  $('#btn-play').onclick = togglePlay;
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#mini-play').onclick = e => { e.stopPropagation(); togglePlay(); };
  $('#mini-next').onclick = e => { e.stopPropagation(); next(); };
  $('#mini-prev').onclick = e => { e.stopPropagation(); prev(); };
  $('#mini-expand').onclick = e => { e.stopPropagation(); openSheet(true); };
  $('#mini-meta').onclick = () => openSheet(true);
  $('#btn-collapse').onclick = () => openSheet(false);
  $('#sheet-bg').onclick = () => openSheet(false);
  $('#btn-shuffle').onclick = toggleShuffle;
  $('#btn-repeat').onclick = cycleRepeat;
  $('#btn-fav-np').onclick = () => toggleFav(queue[qi]);
  $('#btn-mute').onclick = toggleMute;
  $('#vol').oninput = e => setVolume(+e.target.value / 100);
  $('#btn-back').onclick = () => {
    if (view.type === 'album') view = { type: 'albums' };
    else if (view.type === 'artist') view = { type: 'artists' };
    else view = { type: 'albums' };
    render();
  };
  $$('#tabs button').forEach(b => b.onclick = () => {
    searchQ = ''; $('#q').value = '';
    const tab = b.dataset.tab;
    view = { type: tab === 'albums' ? 'albums' : tab === 'songs' ? 'songs' : tab === 'artists' ? 'artists' : tab === 'favorites' ? 'favorites' : 'recent' };
    render();
  });
  let searchTimer;
  $('#q').oninput = e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQ = e.target.value; render(); }, 150);
  };
  const sk = $('#seek');
  sk.oninput = () => { dragging = true; $('#t-cur').textContent = fmt(+sk.value); };
  sk.onchange = () => { dragging = false; seek(+sk.value); };
  $('#mode-gapless').onclick = () => setMode('gapless');
  $('#mode-xf').onclick = () => setMode('crossfade');
  $('#mode-normal').onclick = () => setMode('normal');
  $('#ka').checked = settings.keepAlive;
  $('#ka').onchange = e => { settings.keepAlive = e.target.checked; save(); if (settings.keepAlive && wantPlay) keepAliveStart(); else keepAliveStop(); };
  $('#xf').oninput = e => { settings.crossfade = +e.target.value; $('#xf-val').textContent = settings.crossfade + ' 秒'; };
  $('#xf').onchange = () => { save(); rescheduleNext(); };
  $('#me').checked = settings.mediaEl;
  $('#me').onchange = e => { settings.mediaEl = e.target.checked; save(); location.reload(); };
  $('#btn-cache').onclick = cacheAll;
  $('#btn-queue-panel').onclick = () => { showQueue = !showQueue; if (showQueue) showSleep = false; render(); };
  $('#btn-sleep').onclick = () => { showSleep = !showSleep; if (showSleep) showQueue = false; render(); };
  $('#btn-q-clear').onclick = () => clearQueueKeepCurrent();
  $('#btn-q-from-cur').onclick = () => trimQueueFromCurrent();
  $$('#sleep-panel .sleep-opts button').forEach(b => b.onclick = () => {
    const m = +b.dataset.sleep;
    $('#sleep-panel').dataset.picked = String(m);
    setSleep(m);
  });

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

window.__player = {
  playIndex, next, prev, seek, togglePlay, setQueue, playNow, playNext, enqueue,
  toggleShuffle, cycleRepeat, setVolume, toggleMute, toggleFav, setSleep, openSheet,
  get state() { return { qi, playing, wantPlay, curVoice, nextVoice, queue, settings: { ...settings }, favorites: [...favorites], recent: recent.slice(), sheetOpen }; },
  get bg() { return { keepPlaying: !!(bg.keepEl && !bg.keepEl.paused), wakeLock: !!bg.wakeLock, autoResumes: bg.autoResumes, ctxState: ctx && ctx.state, events: bg.events.slice() }; },
  setMode, tryResume,
  get library() { return library; },
  settings, rescheduleNext,
};
