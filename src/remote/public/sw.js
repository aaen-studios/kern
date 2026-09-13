/* kern remote service worker: offline shell, never touches /api. */

const CACHE = "kern-remote-v3";
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

  // Navigations are network-first so a new panel build is picked up as soon
  // as the host is reachable; the cache is only an offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

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
