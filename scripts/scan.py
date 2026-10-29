#!/usr/bin/env python3
"""扫描 music/ 目录，生成 music/library.json。

用法: python3 scripts/scan.py [音乐目录，默认 ./music]
依赖: mutagen (pip install mutagen)；没有 mutagen 时回退到 ffprobe。

对每首歌输出: title, artist, album, track, disc, file, duration, sampleRate,
以及无缝元数据 gapless = {encoderDelay, padding, validSamples, source}
  - MP3: 解析 LAME/Xing(Info) 头里的 encoder delay / padding (+529 解码器延迟)
  - M4A/AAC: 解析 iTunSMPB
  - FLAC/WAV/OGG: 天然无缝，无需裁剪
前端会对比解码后的实际样本数自动判断是否需要裁剪。
"""
import json, os, re, struct, subprocess, sys

AUDIO_EXT = {'.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'}
COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'front.jpg']

try:
    import mutagen
except ImportError:
    mutagen = None

def parse_lame(path):
    """返回 (encoder_delay, padding, frames, samples_per_frame, sr) 或 None"""
    with open(path, 'rb') as f:
        data = f.read(256 * 1024)
    pos = 0
    if data[:3] == b'ID3':
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        pos = 10 + size
        if data[5] & 0x10: pos += 10
    # 找第一个帧同步
    while pos < len(data) - 4:
        if data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0: break
        pos += 1
    else:
        return None
    h = struct.unpack('>I', data[pos:pos + 4])[0]
    ver = (h >> 19) & 3          # 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    layer = (h >> 17) & 3
    sr_idx = (h >> 10) & 3
    chan = (h >> 6) & 3
    if layer != 1:  # 只处理 Layer III
        return None
    sr_table = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    sr = sr_table.get(ver, [0, 0, 0])[sr_idx] if sr_idx < 3 else 0
    spf = 1152 if ver == 3 else 576
    if ver == 3: side = 17 if chan == 3 else 32
    else:        side = 9 if chan == 3 else 17
    x = pos + 4 + side
    tag = data[x:x + 4]
    if tag not in (b'Xing', b'Info'):
        return None
    flags = struct.unpack('>I', data[x + 4:x + 8])[0]
    p = x + 8
    frames = None
    if flags & 1: frames = struct.unpack('>I', data[p:p + 4])[0]; p += 4
    if flags & 2: p += 4
    if flags & 4: p += 100
    if flags & 8: p += 4
    lame = data[p:p + 36]
    if not (lame[:4] in (b'LAME', b'Lavc', b'Lavf') or re.match(rb'[A-Za-z]{4}', lame[:4] or b'')):
        return None
    d = lame[21:24]
    if len(d) < 3: return None
    delay = (d[0] << 4) | (d[1] >> 4)
    padding = ((d[1] & 0x0F) << 8) | d[2]
    return delay, padding, frames, spf, sr

def parse_itunsmpb(audio):
    try:
        tags = audio.tags or {}
        val = None
        for k in tags.keys():
            if 'iTunSMPB' in str(k):
                v = tags[k]
                v = v[0] if isinstance(v, list) else v
                val = v.decode() if isinstance(v, bytes) else str(v)
                break
        if not val: return None
        parts = val.split()
        return int(parts[1], 16), int(parts[2], 16), int(parts[3], 16)
    except Exception:
        return None

def first(tags, *keys):
    if not tags: return None
    for k in keys:
        if k in tags:
            v = tags[k]
            v = v[0] if isinstance(v, list) else v
            v = getattr(v, 'text', [v])
            v = v[0] if isinstance(v, list) else v
            if v: return str(v)
    return None

def num(s):
    if not s: return None
    m = re.match(r'\d+', str(s))
    return int(m.group()) if m else None

def ffprobe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:format_tags:stream=sample_rate',
                          '-of', 'json', path], capture_output=True, text=True).stdout
    j = json.loads(out or '{}')
    fmt = j.get('format', {}); tags = {k.lower(): v for k, v in fmt.get('tags', {}).items()}
    sr = int((j.get('streams') or [{}])[0].get('sample_rate', 0) or 0)
    return float(fmt.get('duration', 0)), sr, tags

def scan(root):
    tracks = []
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for name in sorted(fn):
            ext = os.path.splitext(name)[1].lower()
            if ext not in AUDIO_EXT: continue
            full = os.path.join(dp, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            title = artist = album = None; track = disc = None; dur = 0; sr = 0
            if mutagen:
                easy = mutagen.File(full, easy=True)
                if easy is not None:
                    dur = float(getattr(easy.info, 'length', 0) or 0)
                    sr = int(getattr(easy.info, 'sample_rate', 0) or 0)
                    t = easy.tags or {}
                    title = first(t, 'title'); artist = first(t, 'artist', 'albumartist'); album = first(t, 'album')
                    track = num(first(t, 'tracknumber')); disc = num(first(t, 'discnumber'))
            if not dur:
                dur, sr, t = ffprobe(full)
                title = title or t.get('title'); artist = artist or t.get('artist'); album = album or t.get('album')
                track = track or num(t.get('track'))
            gap = None
            if ext == '.mp3':
                r = parse_lame(full)
                if r:
                    delay, pad, frames, spf, fsr = r
                    valid = frames * spf - delay - pad if frames else None
                    # 529 = MP3 解码器固有延迟
                    gap = {'encoderDelay': delay + 529, 'padding': max(pad - 529, 0),
                           'validSamples': valid, 'source': 'LAME'}
            elif ext in ('.m4a', '.aac') and mutagen:
                a = mutagen.File(full)
                r = parse_itunsmpb(a) if a else None
                if r:
                    gap = {'encoderDelay': r[0], 'padding': r[1], 'validSamples': r[2], 'source': 'iTunSMPB'}
            cover = None
            for c in COVER_NAMES:
                if os.path.exists(os.path.join(dp, c)):
                    cover = os.path.relpath(os.path.join(dp, c), root).replace(os.sep, '/'); break
            tracks.append({
                'title': title or os.path.splitext(name)[0],
                'artist': artist or '未知艺人',
                'album': album or (os.path.basename(dp) if dp != root else '未分类'),
                'track': track, 'disc': disc, 'file': rel, 'cover': cover,
                'duration': round(dur, 3), 'sampleRate': sr, 'gapless': gap,
            })
    tracks.sort(key=lambda t: (t['album'].lower(), t['disc'] or 1, t['track'] or 999, t['file']))
    return tracks

if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'music')
    root = os.path.abspath(root)
    lib = {'version': 1, 'tracks': scan(root)}
    out = os.path.join(root, 'library.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(lib, f, ensure_ascii=False, indent=2)
    print(f'已写入 {out}，共 {len(lib["tracks"])} 首')
