#!/usr/bin/env python3
"""用无头 Chromium (Playwright) 运行测试。
1) tests/offline.html：OfflineAudioContext 离线渲染，逐样本检查无缝/交叉淡入
2) index.html 实时测试：真实 AudioContext 下，下一首是否提前在音频时钟上调度、起点 == 上一首终点
3) 循环 / 随机基础逻辑
用法: python3 tests/run_tests.py
"""
import json, os, subprocess, sys, time, socket
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(port), '127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
base = f'http://127.0.0.1:{port}'
failed = 0
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        print('Chromium', b.version)
        pg = b.new_page()
        logs = []; pg.on('console', lambda m: logs.append(m.text)); pg.on('pageerror', lambda e: logs.append('ERR ' + str(e)))
        pg.goto(base + '/tests/offline.html')
        pg.wait_for_function('window.__results', timeout=180000)
        for r in pg.evaluate('window.__results'):
            failed += not r['pass']
            print(('PASS ' if r['pass'] else 'FAIL ') + r['name'], json.dumps({k: v for k, v in r.items() if k not in ('name', 'pass')}, ensure_ascii=False))
        if logs: print('console:', logs)

        # ---- 实时播放测试 ----
        pg = b.new_page(viewport={'width': 1920, 'height': 1080})
        logs = []; pg.on('pageerror', lambda e: logs.append('ERR ' + str(e)))
        pg.goto(base + '/index.html')
        pg.wait_for_selector('.album')
        pg.wait_for_selector('#mini')
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-albums.png'))
        # 迷你栏布局截图
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-mini.png'))
        pg.locator('.album', has_text='国内连通性试听').click()
        pg.wait_for_selector('.track-main')
        pg.locator('.track-main', has_text='连通性测试').click()
        pg.wait_for_function('window.__player.state.curVoice', timeout=30000)
        pg.wait_for_timeout(500)
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-connectivity.png'))
        pg.click('#mini-expand')
        pg.wait_for_selector('#now.open')
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-expanded.png'))
        pg.click('#btn-collapse')
        pg.wait_for_function('!document.getElementById("now").classList.contains("open")')
        pg.click('#btn-back')
        pg.wait_for_selector('.album')
        pg.locator('.album', has_text='Wallpaper — Gapless Split').click()
        pg.wait_for_selector('.track-main')
        pg.click('.track-main >> nth=0')   # 第 1 首
        pg.wait_for_function('window.__player.state.curVoice')
        dur = pg.evaluate('window.__player.state.curVoice.trackDur')
        pg.evaluate(f'window.__player.seek({dur} - 4)')   # 跳到结尾前 4 秒
        pg.wait_for_function('window.__player.state.nextVoice', timeout=30000)
        sched = pg.evaluate('''() => { const s = window.__player.state; return {
            now: __ctx.currentTime, curEnd: s.curVoice.end, nextWhen: s.nextVoice.when, sr: __ctx.sampleRate, state: __ctx.state,
            baseLatency: __ctx.baseLatency, outputLatency: __ctx.outputLatency } }''')
        lead = sched['nextWhen'] - sched['now']
        same = abs(sched['nextWhen'] - sched['curEnd']) < 0.5 / sched['sr']
        ok = same and lead > 1.0 and sched['state'] == 'running'
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '实时：下一首在音频时钟上提前调度，起点 == 上一首终点', json.dumps({**sched, 'leadSeconds': round(lead, 3)}))
        pg.wait_for_function('window.__player.state.qi === 1', timeout=15000)
        t0 = pg.evaluate('__ctx.currentTime'); time.sleep(1.0); t1 = pg.evaluate('__ctx.currentTime')
        title = pg.text_content('#np-title')
        ok = title == 'Wallpaper (Part 2)' and t1 > t0
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '实时：自动切到第 2 首，界面/Media Session 更新', json.dumps({'title': title, 'clockAdvanced': round(t1 - t0, 3), 'log': pg.evaluate('__engine.log')}, ensure_ascii=False))
        ms = pg.evaluate('navigator.mediaSession.metadata && navigator.mediaSession.metadata.title')
        print('INFO Media Session metadata.title =', ms)

        # ---- 循环 / 随机 / 音量 / 收藏 ----
        logic = pg.evaluate('''() => {
          const P = window.__player;
          const lib = P.library.slice(0, Math.min(4, P.library.length));
          if (P.settings.shuffle) P.toggleShuffle();
          P.settings.repeat = 'off';
          P.setQueue(lib, 0);
          const file0 = P.state.queue[0].file;
          if (!P.settings.shuffle) P.toggleShuffle();
          const shuffleKeeps = P.settings.shuffle && P.state.queue[P.state.qi].file === file0 && P.state.qi === 0;
          if (P.settings.shuffle) P.toggleShuffle();
          const shuffleOff = P.settings.shuffle === false;
          P.settings.repeat = 'one';
          const repOne = P.settings.repeat === 'one';
          P.cycleRepeat(); // one -> off
          const cycled = P.settings.repeat === 'off';
          P.cycleRepeat(); // off -> all
          const toAll = P.settings.repeat === 'all';
          P.setVolume(0.5);
          const volOk = Math.abs(P.settings.volume - 0.5) < 0.001 && !P.settings.muted;
          const t = lib[0];
          const before = P.state.favorites.includes(t.file);
          P.toggleFav(t);
          const after = P.state.favorites.includes(t.file);
          const favOk = before !== after;
          if (after) P.toggleFav(t); // restore
          // UI controls exist
          const ui = !!(document.getElementById('btn-shuffle') && document.getElementById('btn-repeat')
            && document.getElementById('vol') && document.getElementById('q')
            && document.getElementById('btn-queue-panel') && document.getElementById('btn-sleep')
            && document.getElementById('mini') && document.getElementById('mini-expand')
            && document.getElementById('btn-collapse'));
          const miniLayout = getComputedStyle(document.getElementById('mini')).position === 'fixed'
            && !document.getElementById('now').classList.contains('open');
          return { shuffleKeeps, shuffleOff, repOne, cycled, toAll, volOk, favOk, ui, miniLayout };
        }''')
        ok = all(logic.values())
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '循环/随机/音量/收藏/控件', json.dumps(logic, ensure_ascii=False))

        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-playing.png'))
        if logs: print('page errors:', logs); failed += 1
        b.close()
finally:
    srv.terminate()
print('\n全部通过' if not failed else f'\n{failed} 项失败')
sys.exit(1 if failed else 0)
