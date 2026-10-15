const CACHE = 'inspiration-pond-v1.1.0-text-and-drawing';
const FILES = ['./', './index.html', './styles.css', './core.js', './database.js', './app.js', './drawing.js', './assets/pond-water.webp', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
const ASSETS = new Set(FILES.map(file => new URL(file, self.location.href).href));
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('inspiration-pond-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !ASSETS.has(event.request.url)) return;
  event.respondWith(fetch(event.request).then(response => { if (response.ok && !response.redirected && response.type !== 'opaque') { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); } return response; }).catch(async () => { const cached = await caches.match(event.request); if (cached) return cached; if (event.request.mode === 'navigate') return (await caches.match(new URL('./index.html', self.location.href).href)) || Response.error(); return Response.error(); }));
});
