/* kern remote service worker: offline shell, never touches /api. */

const CACHE = "kern-remote-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-128.png", "/icon-32.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // API calls and streams always go to the network.
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((res) => {
            // Hashed assets are immutable; cache them as they're fetched.
            if (res.ok && url.origin === location.origin) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => caches.match("/")),
    ),
  );
});
