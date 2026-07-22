const CACHE_NAME = "watch-tv-plus-shell-v1";
const SHELL_FILES = [
  "./",
  "./manifest.webmanifest",
  "./icons/watch-tv-plus-192.png",
  "./icons/watch-tv-plus-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => undefined)
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request,copy)).catch(() => undefined);
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match("./")))
  );
});
