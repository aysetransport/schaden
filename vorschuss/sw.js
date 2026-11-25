// Vorschüsse: App-Hülle offline verfügbar (zuerst Netz, sonst Zwischenspeicher). Daten gehen nie hierüber, nur über die Cloud.
const CACHE = 'vorschuss-1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'manifest.webmanifest', '../icon-192.png']))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const k = r.clone(); caches.open(CACHE).then(c => c.put(e.request, k)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
