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
        pg.locator('.album', has_text='无缝对比测试').click()
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
        ok = title == '无缝对比 第2段' and t1 > t0
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '实时：自动切到第 2 首，界面/Media Session 更新', json.dumps({'title': title, 'clockAdvanced': round(t1 - t0, 3), 'log': pg.evaluate('__engine.log')}, ensure_ascii=False))
        ms = pg.evaluate('navigator.mediaSession.metadata && navigator.mediaSession.metadata.title')
        print('INFO Media Session metadata.title =', ms)
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-compare.png'))

        # ---- 普通（有间隙）模式：上一首结束后才加载，有 ≥0.3 秒间隙 ----
        pg.click('.cmp-btns button[data-m=normal]')
        pg.wait_for_function('window.__player.state.settings.mode === "normal" && window.__player.state.qi === 0 && window.__player.state.curVoice && window.__player.state.curVoice.seek > 1', timeout=30000)
        pre = pg.evaluate('({ next: !!window.__player.state.nextVoice, pos: __engine.position() })')
        time.sleep(1.5)
        pre2 = pg.evaluate('!!window.__player.state.nextVoice')
        pg.wait_for_function('window.__player.state.qi === 1 && window.__player.state.curVoice', timeout=20000)
        lg = pg.evaluate('__engine.log')
        p1 = [l for l in lg if l['title'] == '无缝对比 第1段'][-1]
        p2 = [l for l in lg if l['title'] == '无缝对比 第2段'][-1]
        gap = p2['when'] - p1['end']
        ok = not pre['next'] and not pre2 and gap >= 0.3
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '普通模式：不预排队，上一首结束后才播下一首（可听出间隙）', json.dumps({'preScheduled': pre['next'] or pre2, 'gapSeconds': round(gap, 3)}))
        pg.evaluate('window.__player.setMode("gapless")')
        ok = pg.evaluate('window.__engine.gaplessOnly === true && window.__player.state.settings.mode === "gapless"')
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '切回无缝模式')

        # ---- 后台保活 / 自动恢复 ----
        bgr = {}
        bgr['keepAliveWhilePlaying'] = pg.evaluate('window.__player.bg.keepPlaying')
        bgr['mediaSessionPlaying'] = pg.evaluate('navigator.mediaSession.playbackState') == 'playing'
        # 模拟切到后台（无头浏览器无法真正切走，用 visibilityState 覆盖 + 派发事件）
        pg.evaluate('''() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
                       Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
                       document.dispatchEvent(new Event('visibilitychange')); }''')
        t0 = pg.evaluate('__ctx.currentTime'); time.sleep(1.0); t1 = pg.evaluate('__ctx.currentTime')
        bgr['playsAfterHidden'] = t1 - t0 > 0.5 and pg.evaluate('__ctx.state') == 'running'
        # 模拟系统挂起 AudioContext（不是用户暂停）→ 应自动恢复
        pg.evaluate('__ctx.suspend()')
        pg.wait_for_function('__ctx.state === "running" && window.__player.bg.autoResumes > 0', timeout=10000)
        bgr['autoResumeAfterSystemSuspend'] = True
        pg.evaluate('''() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }''')
        # 模拟 pagehide 时被挂起 → 也会恢复
        pg.evaluate('__ctx.suspend().then(() => window.dispatchEvent(new Event("pagehide")))')
        pg.wait_for_function('__ctx.state === "running"', timeout=10000)
        bgr['resumeOnPagehide'] = True
        # 用户主动暂停：不能被自动恢复，保活音轨应停止
        pg.evaluate('window.__player.togglePlay()')
        time.sleep(1.5)
        bgr['userPauseStays'] = pg.evaluate('__ctx.state') == 'suspended' and not pg.evaluate('window.__player.state.playing')
        bgr['keepAliveStopsOnPause'] = not pg.evaluate('window.__player.bg.keepPlaying')
        bgr['mediaSessionPaused'] = pg.evaluate('navigator.mediaSession.playbackState') == 'paused'
        pg.evaluate('window.__player.togglePlay()')
        time.sleep(0.5)
        bgr['resumeByUser'] = pg.evaluate('__ctx.state') == 'running' and pg.evaluate('window.__player.bg.keepPlaying')
        ok = all(bgr.values())
        failed += not ok
        print(('PASS ' if ok else 'FAIL ') + '后台：保活音轨/切后台继续播/系统挂起自动恢复/用户暂停不恢复', json.dumps({**bgr, 'events': pg.evaluate('window.__player.bg.events')}, ensure_ascii=False))
        pg.click('#mini-expand'); pg.wait_for_selector('#now.open'); pg.wait_for_timeout(400)
        pg.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-modes.png'))
        pg.click('#btn-collapse')

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
