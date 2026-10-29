# 特斯拉车机无缝播放器（原型）

一个在车机 Chromium 浏览器里运行的网页播放器（PWA），用 Web Audio API 实现**无缝衔接**和**交叉淡入淡出**（0–12 秒）。

## 目录
```
index.html  app.js  engine.js  sw.js  manifest.json  icons/
serve.py                 极简静态服务器（支持 Range）
scripts/scan.py          扫描 music/，生成 music/library.json
music/                   音乐与 library.json、LICENSES.md（测试音源均为 CC BY 4.0）
tests/offline.html       OfflineAudioContext 离线渲染测试页
tests/run_tests.py       无头 Chromium（Playwright）自动测试
```

## 运行
```bash
pip install mutagen playwright && python3 -m playwright install chromium   # 首次
python3 scripts/scan.py          # 生成/更新曲库
python3 serve.py 8080            # 打开 http://<电脑IP>:8080/
python3 tests/run_tests.py       # 跑自动测试
```

## 放入你自己的音乐
只放你**合法拥有、无 DRM** 的文件：iTunes Store 购买的 AAC（.m4a）、自己翻录的 CD（建议 FLAC）、Bandcamp 等平台买的下载版。
Apple Music 订阅下载、网易云 .ncm、QQ 音乐加密格式都有 DRM，不能用，也不要去破解。

1. 每张专辑建一个文件夹放进 `music/`，可选放一张 `cover.jpg`。
2. 运行 `python3 scripts/scan.py`，脚本会读取标签（曲名/艺人/专辑/曲序）、时长，以及无缝元数据：
   - MP3：LAME/Xing 头里的编码器延迟和补零（自动加上 529 个解码器延迟）
   - M4A：iTunSMPB
   - FLAC/WAV：天然无缝
3. 刷新页面。

**格式建议：** FLAC 最稳。MP3 需要带 LAME 头（LAME 或 ffmpeg 编码默认带）；没有 LAME 头的 MP3 曲间会有约 25–50 ms 的空隙。

## 原理
- 当前曲目开始播放后，就预先下载并解码下一首，再用 `AudioBufferSourceNode.start(when)` 把它排在上一首结束的那个采样点上。时间按音频时钟（`AudioContext.currentTime`）计算，并对齐到采样。
- JS 定时器只负责“提前准备”。切歌由音频时钟上的标记节点触发 `ended` 事件，所以即使后台定时器被限流，也不会出现停顿。
- 交叉淡入采用等功率曲线（sin/cos）。**同一专辑的连续曲目始终无缝，不做淡入淡出。**
- 暂停使用 `AudioContext.suspend()`，已经排好的下一首不会丢。
- Media Session：设置了曲目信息和播放/暂停/上一首/下一首/拖动进度的处理函数。默认把音频经一个 `<audio>` 元素输出，这样浏览器才会把本页当作“正在播放媒体”。
- Service Worker 会缓存应用外壳。点「离线缓存全部歌曲」可以把音乐存进浏览器缓存。

## 已验证 / 未验证
已在无头 Chromium 156 上自动验证（`tests/last-run.txt`）：
- 合成正弦切两段后拼接，误差 1.5e-8
- FLAC 分割对与原始连续音频逐样本一致（差值 0）
- 带 LAME 头的 MP3：Chromium 解码时自动裁剪，边界无间隙、无错位
- 无 LAME 头的 MP3：由引擎按元数据裁剪，同样无缝
- 对照组（无元数据的 MP3、人为插入 10 ms 空隙）都能被检测出来，说明测试是有效的
- 交叉淡入 3 秒时 RMS 波动 0.28 dB
- 实时 AudioContext 下，下一首提前约 3.8 秒排进音频时钟，起点等于上一首终点，并能自动切歌

**未验证（需要上车实测）：**
- 车机实际出声，以及长时间后台播放
- 行驶中浏览器的行为
- 方向盘按键或车机媒体控件能否通过 Media Session 控制
- 车机内存能否承受（每首 4 分钟立体声解码后约 85 MB，同时保留 2 首）
- 车机浏览器是否允许注册 Service Worker（需要 HTTPS）

## 让车机能访问（本原型没有做任何公网部署）
车机必须能打开这个网址。Service Worker 和 PWA 要求 **HTTPS**（localhost 除外）。
1. **手机热点 + 局域网（最快的实测方法）**：笔记本和车都连手机热点，运行 `python3 serve.py 8080`，车机打开 `http://<笔记本IP>:8080`。走 HTTP 时 Service Worker 不生效，但播放功能可以用。
2. **家里 NAS 或常开电脑 + Cloudflare Tunnel**（`cloudflared tunnel`）：会得到一个 HTTPS 域名，不需要公网 IP。Cloudflare 在国内访问可能慢或不稳定，需要实测。
3. **境外 VPS 或静态托管**（Cloudflare Pages、Vercel、Netlify）+ HTTPS：音乐文件较大，要注意流量；**务必加访问控制**（Cloudflare Access 或 Basic Auth）。把自己的音乐公开放到网上会构成公开传播，有版权风险。
4. **国内服务器或国内 CDN**：用域名对外提供网站需要 **ICP 备案**，个人备案还需要实名，周期也较长。如果只是自己在内网或私有隧道里用，就不涉及这一步。

## 关于 The Weeknd《Hurry Up Tomorrow》
这张专辑受版权保护，本项目**没有下载**它，也不提供获取渠道。如果想在车上无缝播放，可以购买正版的无 DRM 版本（例如 iTunes Store 的 AAC，或者 CD 自己翻录成 FLAC），放进 `music/`，然后运行 `scan.py`。
