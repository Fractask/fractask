// Minimal service worker — required by Chrome to surface the "Install app"
// menu item. We don't cache anything; pages are gated by middleware so
// offline support would just confuse the auth flow. The fetch listener is
// a passthrough so installability checks pass.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // intentional no-op — let the network handle every request
});
