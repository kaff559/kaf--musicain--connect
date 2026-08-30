'use strict';

// Bump this on every deploy so old clients pick up the new app shell instead
// of being stuck on a stale cache.
const CACHE_NAME = 'kaf-musician-connect-v2';

const APP_SHELL = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

// The app's own code/markup — these change on every deploy, so they're
// served network-first (see below) rather than cached-first like the icons
// and manifest above, which rarely change.
const NETWORK_FIRST = ['/', '/index.html', '/styles.css', '/app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache the API — bookings, auth, search results, etc. must always
  // be live. Let those requests pass straight through to the network.
  if (url.pathname.startsWith('/api/')) return;

  if (NETWORK_FIRST.includes(url.pathname)) {
    // Always try the network first so a new deploy is picked up immediately.
    // Only fall back to whatever's cached if the network request fails
    // (offline), so the app still opens without a connection.
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Everything else (icons, manifest): cache-first, since these rarely
  // change and don't need to be re-fetched on every load.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});