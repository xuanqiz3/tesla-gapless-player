#!/usr/bin/env python3
"""生成「无缝对比测试」专辑：一段 36 秒连续音乐（稳定节拍 + 持续和弦 + 十六分音符琶音），
在非帧对齐、非拍点的采样点切成 3 段，编码为带 LAME 头的 MP3（ffmpeg libmp3lame）。
无缝播放时三段连起来与原曲一致；普通（有间隙）模式下切点处会听到明显顿挫。
用法: python3 scripts/make_compare.py   （需要 numpy、ffmpeg）
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 44100
BPM = 120
BEAT = 60 / BPM
TOTAL = 36.0
CUTS = [529917, 1046123]  # ≈12.02 s、≈23.72 s：故意落在拍子中间和持续和弦上
OUT = os.path.join(os.path.dirname(__file__), '..', 'music', 'compare')

n = int(TOTAL * SR)
t = np.arange(n) / SR
mix = np.zeros((n, 2))

def note(f): return 440 * 2 ** ((f - 69) / 12)
# 和弦进行（每 2 小节=4 秒换一次，渐变过渡，保证持续音不断）
prog = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]]
seg = 4.0
pad = np.zeros(n)
for k in range(int(TOTAL / seg) + 1):
    ch = prog[k % 4]
    env = np.clip(1 - np.abs((t - (k * seg + seg / 2)) / (seg / 2 + 0.6)), 0, 1) ** 0.5
    for m in ch:
        f = note(m)
        pad += env * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t + 0.5)) * 0.06
# 琶音（十六分音符，跟随和弦）
arp = np.zeros(n)
step = BEAT / 4
for i in range(int(TOTAL / step)):
    st = i * step
    ch = prog[int(st // seg) % 4]
    m = ch[[0, 1, 2, 3, 2, 1][i % 6]] + 12
    a, b = int(st * SR), min(n, int((st + step * 1.6) * SR))
    tt = np.arange(b - a) / SR
    arp[a:b] += np.sin(2 * np.pi * note(m) * tt) * np.exp(-tt * 9) * 0.16
# 底鼓（每拍）+ 踩镲（每八分）
rng = np.random.default_rng(7)
drum = np.zeros(n)
for i in range(int(TOTAL / BEAT)):
    a = int(i * BEAT * SR); L = min(n - a, int(0.35 * SR)); tt = np.arange(L) / SR
    f = 50 + 90 * np.exp(-tt * 30)
    drum[a:a + L] += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.5
for i in range(int(TOTAL / (BEAT / 2))):
    a = int(i * BEAT / 2 * SR); L = min(n - a, int(0.06 * SR)); tt = np.arange(L) / SR
    drum[a:a + L] += rng.standard_normal(L) * np.exp(-tt * 60) * (0.08 if i % 2 else 0.05)
mix[:, 0] = pad + arp * 0.8 + drum
mix[:, 1] = pad + arp * 1.0 + drum
# 首尾 30 ms 淡入淡出（只在整段开头和结尾，切点处不淡）
fl = int(0.03 * SR)
mix[:fl] *= np.linspace(0, 1, fl)[:, None]; mix[-fl:] *= np.linspace(1, 0, fl)[:, None]
mix /= np.max(np.abs(mix)) / 0.89
pcm = (mix * 32767).astype('<i2')

os.makedirs(OUT, exist_ok=True)
bounds = [0] + CUTS + [n]
for i in range(3):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tf: wav = tf.name
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm[bounds[i]:bounds[i + 1]].tobytes())
    dst = os.path.join(OUT, f'compare-part{i + 1}.mp3')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k',
                    '-metadata', f'title=无缝对比 第{i + 1}段', '-metadata', 'artist=无缝对比测试音（合成）',
                    '-metadata', 'album=无缝对比测试', '-metadata', f'track={i + 1}/3', dst], check=True)
    os.unlink(wav)
    print(dst, (bounds[i + 1] - bounds[i]) / SR, 's', os.path.getsize(dst), 'bytes')
# 供自动测试比对用的原始连续音频（不进曲库）
fx = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'compare-full.flac')
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf: fw = tf.name
with wave.open(fw, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(fx)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', fw, fx], check=True)
os.unlink(fw)
