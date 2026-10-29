# 测试音源授权

全部来自 Kevin MacLeod（incompetech.com），授权为 **Creative Commons Attribution 4.0（CC BY 4.0）**：https://creativecommons.org/licenses/by/4.0/
署名格式："<曲名>" Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0 License。
下载日期：2026-10-29。

| 文件 | 曲名 | 艺人 | 授权 | 来源 URL |
|---|---|---|---|---|
| carefree.mp3 | Carefree | Kevin MacLeod | CC BY 4.0 | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3 |
| fluffing-a-duck.mp3 | Fluffing a Duck | Kevin MacLeod | CC BY 4.0 | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Fluffing%20a%20Duck.mp3 |
| local-forecast-elevator.mp3 | Local Forecast - Elevator（文件内标签写作 "Local Elevator - Elevator"） | Kevin MacLeod | CC BY 4.0 | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Local%20Forecast%20-%20Elevator.mp3 |
| sneaky-snitch.mp3 | Sneaky Snitch | Kevin MacLeod | CC BY 4.0 | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sneaky%20Snitch.mp3 |
| gapless-test/wallpaper-part1/2.flac、.mp3 | Wallpaper（改编：在第 4,410,000 个采样处（100.000 秒）切成两段，用于无缝测试） | Kevin MacLeod | CC BY 4.0（已修改） | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3 |

改动说明：Wallpaper 原 MP3 解码为 44.1 kHz WAV 后按采样精确切分，另存为 FLAC，再用 ffmpeg/libmp3lame 192 kbps 编码 MP3（带 LAME 头）。
`tests/fixtures/*-noxing.mp3` 是同样内容但去掉 LAME/Xing 头的版本，仅用于测试。
