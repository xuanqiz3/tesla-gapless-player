// 无缝 / 交叉淡入播放引擎（Web Audio API）
// 同时支持 AudioContext（实时播放）与 OfflineAudioContext（离线渲染测试）。
// 核心思路：所有曲目都用 AudioBufferSourceNode.start(when, offset, duration)
// 在音频时钟（ctx.currentTime）上预先调度；JS 定时器只负责“提前准备”，
// 不负责“准时触发”，因此即便后台定时器被限流也不会产生间隙。

export class GaplessEngine extends EventTarget {
  constructor(ctx, output) {
    super();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(output || ctx.destination);
    this.voices = [];          // 已调度/正在播放的声部
    this.cache = new Map();    // url -> Promise<AudioBuffer>
    this.crossfade = 0;        // 秒，0 = 纯无缝
    this.gaplessOnly = true;   // true：所有切换都不淡入淡出
    this.log = [];             // 调度日志（测试用）
  }

  setVolume(v) {
    this.master.gain.setValueAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime);
  }

  // ---------- 加载与裁剪 ----------
  load(url) {
    if (!this.cache.has(url)) {
      const p = fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText || ''}`.trim() + `: ${url}`);
        return r.arrayBuffer();
      }).then(ab => {
        if (!ab || !ab.byteLength) throw new Error(`空文件: ${url}`);
        return this.ctx.decodeAudioData(ab.slice(0)).catch(err => {
          throw new Error(`解码失败（车机可能不支持该格式，请用 MP3）: ${err && err.message || err}`);
        });
      });
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
    }
    return this.cache.get(url);
  }
  // 只保留最近需要的解码缓存，避免车机内存吃紧（每首 4 分钟立体声约 85 MB）
  prune(keepUrls) {
    for (const k of [...this.cache.keys()]) if (!keepUrls.includes(k)) this.cache.delete(k);
  }

  // 依据 library.json 中的 gapless 元数据计算有效区间（offset / duration，秒）。
  // 浏览器的 MP3 解码器有的会自动去掉编码器补零、有的不会，所以这里按解码后
  // 实际样本数自动判断：接近 validSamples → 已裁剪；接近 valid+delay+padding → 需要裁剪。
  static trimInfo(buffer, gapless) {
    const full = { offset: 0, duration: buffer.duration, trimmed: 'none' };
    if (!gapless || !gapless.validSamples || !gapless.sampleRate && !buffer.sampleRate) return full;
    const ratio = buffer.sampleRate / (gapless.sampleRate || buffer.sampleRate);
    const valid = gapless.validSamples * ratio;
    const delay = gapless.encoderDelay * ratio;
    const len = buffer.length;
    const tol = Math.max(16, Math.min(576 * ratio, delay / 2)); // 小于编码器延迟的一半，避免误判
    if (Math.abs(len - valid) <= tol) return { ...full, trimmed: 'decoder' };
    if (len >= valid + delay - tol) {
      return { offset: delay / buffer.sampleRate, duration: valid / buffer.sampleRate, trimmed: 'engine' };
    }
    return full;
  }

  // ---------- 调度 ----------
  snap(t) { const sr = this.ctx.sampleRate; return Math.round(t * sr) / sr; }

  // 在 when（音频时钟）开始播放 track，从曲内 seek 秒开始。fadeIn>0 时做等功率淡入。
  schedule(track, buffer, when, seek = 0, fadeIn = 0) {
    const ctx = this.ctx;
    const trim = GaplessEngine.trimInfo(buffer, track.gapless && { ...track.gapless, sampleRate: track.sampleRate });
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    src.connect(gain).connect(this.master);
    when = this.snap(Math.max(when, 0));
    const offset = trim.offset + seek;
    const playDur = Math.max(trim.duration - seek, 0);
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.setValueCurveAtTime(GaplessEngine.curve(true), when, fadeIn);
    }
    src.start(when, offset, playDur);
    const voice = { track, src, gain, when, seek, trackDur: trim.duration, end: this.snap(when + playDur), trim: trim.trimmed };
    this.voices.push(voice);
    src.onended = () => { this.voices = this.voices.filter(v => v !== voice); this.dispatchEvent(new CustomEvent('voiceended', { detail: voice })); };
    this.log.push({ title: track.title, scheduledAt: ctx.currentTime, when, end: voice.end, offset, trim: trim.trimmed, fadeIn });
    return voice;
  }

  // 等功率曲线：淡入 sin，淡出 cos
  static curve(fadeIn, n = 256) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * Math.PI / 2; c[i] = fadeIn ? Math.sin(x) : Math.cos(x); }
    return c;
  }

  // 计算 cur 之后下一首的切换时长：同专辑连续曲目强制无缝。
  transitionFor(cur, next) {
    if (this.gaplessOnly || !this.crossfade) return 0;
    if (cur.album && cur.album === next.album) return 0;
    return this.crossfade;
  }

  // 把 next 接在 voice 之后：无缝时 when = voice.end（样本对齐）；交叉淡入时提前 xf 秒。
  scheduleAfter(voice, nextTrack, nextBuffer) {
    let xf = Math.min(this.transitionFor(voice.track, nextTrack), (voice.end - voice.when) / 2, nextBuffer.duration / 2);
    const when = voice.end - xf;
    if (xf > 0) {
      const g = voice.gain.gain;
      const start = Math.max(when, this.ctx.currentTime);
      g.cancelScheduledValues(start);
      g.setValueAtTime(1, start);
      g.setValueCurveAtTime(GaplessEngine.curve(false), start, voice.end - start);
    }
    return this.schedule(nextTrack, nextBuffer, when, 0, xf);
  }

  stopAll() {
    for (const v of this.voices) { try { v.src.onended = null; v.src.stop(); v.src.disconnect(); } catch (e) {} }
    this.voices = [];
  }

  // 当前（最早开始且尚未结束的）声部
  current() {
    const t = this.ctx.currentTime;
    const live = this.voices.filter(v => v.when <= t + 0.001 && v.end > t).sort((a, b) => b.when - a.when);
    return live[0] || this.voices.slice().sort((a, b) => a.when - b.when)[0] || null;
  }
  position(v = this.current()) { return v ? Math.min(Math.max(this.ctx.currentTime - v.when, 0) + v.seek, v.trackDur) : 0; }
}
