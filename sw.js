const CACHE_NAME = 'gitslim-v12';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install - cache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate - clean old caches and take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Notification click - open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('GitSlim') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('./');
    })
  );
});

// Fetch - network first, fallback to cache (so updates always come through)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
