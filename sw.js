// Hält die App-Dateien vor, damit sie auch ohne Netz startet. Netz zuerst: Updates kommen sofort an.
const SPEICHER = 'schadensfaelle-v1';
const DATEIEN = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(SPEICHER).then(c => c.addAll(DATEIEN)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(namen => Promise.all(namen.filter(n => n !== SPEICHER).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return; // Cloud-Aufrufe nie zwischenspeichern
  e.respondWith(fetch(e.request)
    .then(antwort => { const kopie = antwort.clone(); caches.open(SPEICHER).then(c => c.put(e.request, kopie)); return antwort; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(treffer => treffer || caches.match('index.html'))));
});
