// Panvas Service Worker — Localhost Cache-Buster & Production Shell Cache
if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(key => caches.delete(key))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.claim())
        .then(() => self.clients.matchAll())
        .then(clients => {
          for (const client of clients) {
            client.navigate(client.url);
          }
        })
    );
  });
  self.addEventListener('fetch', event => {
    event.respondWith(fetch(event.request));
  });
} else {
  const CACHE_NAME = 'panvas-shell-v3';
  const SHELL = ['./', './index.html', './excalidraw-config.js'];

  self.addEventListener('install', event => {
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
  });

  self.addEventListener('activate', event => {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
      event.respondWith(
        fetch(request)
          .then(response => {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
            return response;
          })
          .catch(() => caches.match('./index.html'))
      );
      return;
    }

    event.respondWith(
      caches.match(request).then(cached =>
        cached ??
        fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
      )
    );
  });
}

