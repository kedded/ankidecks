const V = 'recall-v3';
const SHELL = ['./', 'index.html', 'style.css', 'recall-engine.js', 'recall-app.js', 'manifest.json',
  'jszip.min.js', 'fzstd.js', 'sql-wasm.js', 'sql-wasm.wasm',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => {
  // best effort: a missing file must never block the worker from installing
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// network-first: always the newest files when online, cache only when offline
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(V);
    try {
      const res = await fetch(new Request(r.url, { cache: 'no-cache', credentials: 'same-origin' }));
      if (res.ok) c.put(r, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(r, { ignoreSearch: true });
      if (hit) return hit;
      if (r.mode === 'navigate') { const i = await c.match('index.html'); if (i) return i; }
      throw err;
    }
  })());
});
