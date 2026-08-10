// Minimal app-shell service worker.
//
// Two jobs only:
//  1. Satisfy Chrome/Android's installability criteria (a registered SW
//     with a fetch handler) so "Zum Startbildschirm hinzufügen" is offered
//     there the way it already works out of the box on iOS Safari.
//  2. Let the static shell (markup, styles, pollen-logic.js, icons) still
//     load when fully offline, instead of the browser's native offline
//     error page.
//
// Pollen data itself is deliberately NOT cached here — that's already
// handled by the app's own localStorage cache + fetch-timeout logic in
// index.html, which understands data freshness. This worker only ever
// touches same-origin shell assets and leaves every API call (DWD/LGL
// redirects, Open-Meteo) to pass straight through untouched.

const CACHE_NAME = 'pollen-shell-v1';
const SHELL_PATHS = [
  '/',
  '/index.html',
  '/pollen-logic.js',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  '/icons/og-image.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin (Open-Meteo etc.) — passthrough
  if (!SHELL_PATHS.includes(url.pathname)) return;  // /dwd-api, /lgl-api etc. — passthrough

  // Network-first so a deploy is picked up immediately while online;
  // fall back to the cached shell only when the network is unreachable.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
