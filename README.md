# 特斯拉车机无缝播放器

一个在车机 Chromium 浏览器里运行的网页播放器（PWA），用 Web Audio API 实现**无缝衔接**和**交叉淡入淡出**（0–12 秒），并具备网易云 / Apple Music 级别的基础播放功能。

线上：https://xuanqiz3.github.io/tesla-gapless-player/

## 功能
- **无缝 / 交叉淡入**：同专辑连续曲目强制无缝；跨专辑可交叉淡入
- **循环**：关 / 列表循环 / 单曲循环（状态持久化）
- **随机播放**：开/关；开启时保留当前曲并洗牌其余；关闭尽量恢复原顺序
- **音量**：0–100% 滑块 + 静音；经 Web Audio master gain
- **播放队列**：查看、点选跳转、清空（保留当前）、从当前开始、下一首播放、加入队列
- **搜索**：按曲名 / 艺人 / 专辑过滤，结果可直接播放
- **收藏**：本地收藏单曲（心形），浏览页有「收藏」列表
- **浏览分类**：专辑 | 全部歌曲 | 艺人 | 收藏 | 最近播放
- **睡眠定时**：15 / 30 / 45 / 60 分钟后自动暂停
- **最近播放**：本地记录最近 20 首
- **底部迷你栏**：浏览区几乎全屏；点迷你栏/「展开」再打开完整控制面板（车机优先）
- **国内连通性试听**：仓库内置短小 MP3（连通性测试 / 茉莉花合成 / 拨弦 / Espressif 样例），默认直连扬声器
- Media Session、离线缓存（Service Worker）、大触控深色中文 UI

## 目录
```
index.html  app.js  engine.js  sw.js  manifest.json  icons/
serve.py                 极简静态服务器（支持 Range）
scripts/scan.py          扫描 music/，生成 music/library.json
music/                   音乐与 library.json、LICENSES.md（连通性试听 CC0 + Wallpaper CC BY 4.0）
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
- Media Session：设置了曲目信息和播放/暂停/上一首/下一首/拖动进度的处理函数。**默认直连 AudioContext → 扬声器**（车机更稳）；可选「经媒体元素输出」以尝试方向盘控件。
- 设置保存在 `localStorage` 的 `tp-settings`；收藏 `tp-favorites`；最近播放 `tp-recent`。
- Service Worker 会缓存应用外壳。点「离线缓存全部歌曲」可以把音乐存进浏览器缓存。

## 已验证 / 未验证
已在无头 Chromium 上自动验证（`tests/run_tests.py`）：
- 合成正弦 / FLAC（fixtures）/ 带与不带 LAME 头的 MP3 无缝
- 底部迷你栏布局与展开面板
- 交叉淡入等功率
- 实时 AudioContext 下下一首提前排进音频时钟并自动切歌
- 循环 / 随机 / 音量 / 收藏控件与基础逻辑

**未验证（需要上车实测）：**
- 车机实际出声，以及长时间后台播放
- 行驶中浏览器的行为
- 方向盘按键或车机媒体控件能否通过 Media Session 控制
- 车机内存能否承受（每首 4 分钟立体声解码后约 85 MB，同时保留 2 首）
- 车机浏览器是否允许注册 Service Worker（需要 HTTPS）

## 部署
本仓库通过 GitHub Pages 发布。推送到 `main` 后约 1–2 分钟生效。

## 关于版权
测试音源见 `music/LICENSES.md`（连通性试听多为 CC0，Wallpaper 为 CC BY 4.0）。请勿上传受版权保护且无权分发的音乐到公开仓库。
