// Offline cache for the app shell and the libraries. Bump VERSION on each release.
// The page itself loads from the network first so a new release shows on the next open;
// scripts and styles come from this release's cache, filled fresh (bypassing the browser cache) on install.
const VERSION = 'hub-v12';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'more.js', 'agree.js', 'grow.js', 'credit.js', 'config.js', 'sync.js', 'install.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const LIBS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !LIBS.includes(url.hostname)) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) caches.open(VERSION).then(c => c.put('./', res.clone())); return res; })
      .catch(() => caches.open(VERSION).then(c => c.match('./'))));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; });
  }));
});
