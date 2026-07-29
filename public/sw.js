const CACHE_PREFIX = 'openearth-';
const SHELL_CACHE = 'openearth-shell-v2';
const RUNTIME_CACHE = 'openearth-runtime-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './openearth-icon.svg'];
const MAX_RUNTIME_ENTRIES = 180;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
      .map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
        }
        return response;
      })
      .catch(() => caches.match('./index.html')));
    return;
  }

  // Cache application/Cesium assets only. Map data remains under the selected
  // provider or OpenMaps pack's explicit quota and licence policy.
  if (!/\/(?:assets|cesium)\//.test(url.pathname) && !url.pathname.endsWith('manifest.webmanifest') && !url.pathname.endsWith('openearth-icon.svg')) return;
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then(async (response) => {
    if (!response.ok) return response;
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_RUNTIME_ENTRIES)).map((key) => cache.delete(key)));
    return response;
  })));
});
