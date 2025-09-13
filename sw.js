/* PWA Service Worker */
const CACHE = "gold-app-v3"; // 🔁 bump on every deploy

const ASSETS = [
  "/", "/index.html", "/manifest.json", "/favicon.svg",
  "/icons/icon-192.png", "/icons/icon-512.png",
  "/icons/maskable-512.png", "/icons/apple-touch-icon.png",
  // new images
  "/assets/coin_photo_1000x500.webp",
  "/assets/coin_photo_1000x500.png"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // ✅ never handle/capture third-party requests (ads, fonts, APIs, etc.)
  if (url.origin !== self.location.origin) return;

  // ✅ always try network first for navigations (HTML) so updates show immediately
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        caches.open(CACHE).then(c => c.put("/index.html", res.clone()));
        return res;
      }).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // ✅ cache-first for same-origin static assets
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
    )
  );
});
