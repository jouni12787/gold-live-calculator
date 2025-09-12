/* =========================================
   PWA Service Worker (ADDED)
   - Cache the app shell for offline UI
   - Let API requests go to network
   ========================================= */
const CACHE = "gold-app-v1"; // bump to invalidate old cache

/* PWA-PATH: Add your real paths here if using a subpath */
const ASSETS = [
  "/", "/index.html", "/manifest.json", "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png"
];


self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Don't cache gold-api; always go to network for fresh prices
  if (url.hostname.includes("gold-api.com")) return;

  // Cache-first for app shell; network update fallback
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => {
          // Offline fallback to the main page (keeps UI usable)
          if (e.request.mode === "navigate") return caches.match("/index.html");
          return new Response("", { status: 503, statusText: "Offline" });
        });
    })
  );
});
