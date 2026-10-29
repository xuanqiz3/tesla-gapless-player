# 测试音源授权

线上曲库以 **小体积 MP3** 为主，方便国内车机从 GitHub Pages 加载。FLAC 仅保留在 `tests/fixtures/` 供自动测试，不进入公开曲库。

## 国内连通性试听（`music/cn-demo/`）

| 文件 | 曲名 | 来源 / 说明 | 授权 |
|---|---|---|---|
| connectivity-test.mp3 | 连通性测试（请先点这首） | 本仓库用 ffmpeg 合成的短促正弦音阶（约 2 秒） | CC0（本仓库生成） |
| molihua-synth.mp3 | 茉莉花（合成试听） | 公有领域民歌《茉莉花》旋律的合成近似（非录音翻录） | 旋律公有领域；合成实现 CC0 |
| pentatonic-pluck.mp3 | 五声音阶拨弦（合成试听） | 本仓库合成的五声音阶拨弦音色 | CC0（本仓库生成） |
| stereo-sample.mp3 | 样例立体声（Espressif） | 截取自 Espressif 公开测试音频 `ff-16b-2c-44100hz.mp3`（前 18 秒，128 kbps） | 来源：https://dl.espressif.com/dl/audio/ff-16b-2c-44100hz.mp3 （厂商公开样例，仅作连通性测试） |

`gapless-test/molihua-part1.mp3` / `molihua-part2.mp3`：将「茉莉花（合成试听）」对半切开，用于短文件无缝试听；同样 CC0。

## 无缝对比测试（`music/compare/`）

| 文件 | 曲名 | 说明 | 授权 |
|---|---|---|---|
| compare-part1.mp3 | 无缝对比 第1段 | `scripts/make_compare.py` 合成的 36 秒连续音乐（节拍 + 和弦 + 琶音），在第 529,917 采样处切开 | CC0（本仓库生成） |
| compare-part2.mp3 | 无缝对比 第2段 | 同上，第 529,917 – 1,046,123 采样 | CC0（本仓库生成） |
| compare-part3.mp3 | 无缝对比 第3段 | 同上，剩余部分 | CC0（本仓库生成） |

`tests/fixtures/compare-full.flac` 为未切开的原始音频，仅供自动测试比对。

## 测试夹具（不进曲库）

Wallpaper（Kevin MacLeod，CC BY 4.0，https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3）因体积较大、车机上无法播放，已从线上曲库移除；`tests/fixtures/wallpaper-part*.mp3 / .flac / -noxing.mp3` 仅用于自动测试。
署名："Wallpaper" Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0 License https://creativecommons.org/licenses/by/4.0/

## 说明

- 请勿把受版权保护且无权分发的正版流媒体文件上传到公开仓库。
- 后续用户可自行把合法拥有的 MP3/AAC/FLAC 放进 `music/`，再运行 `python3 scripts/scan.py`。
