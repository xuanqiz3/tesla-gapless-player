// Service Worker：应用外壳预缓存；音乐文件走“缓存优先”（仅当已被“离线缓存全部歌曲”存入时）。
const SHELL = 'tp-shell-v2', MUSIC = 'tp-music-v1';
const ASSETS = ['./', 'index.html', 'app.js', 'engine.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  if (u.pathname.endsWith('/library.json')) {           // 曲库：网络优先，离线回退
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
  } else if (u.pathname.includes('/music/')) {          // 音乐：缓存优先
    e.respondWith(caches.open(MUSIC).then(c => c.match(e.request, { ignoreSearch: true })).then(r => r || fetch(e.request)));
  } else {                                               // 外壳：网络优先（方便更新），离线回退缓存
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
  }
});
