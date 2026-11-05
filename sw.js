/* GlobeMap shell cache. Network first, then cache. Same-origin only. */
const CACHE = "globemap-shell-v8";

const SHELL = [
  "./",
  "./index.html",
  "./install.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/solar.js",
  "./js/terminator.js",
  "./js/route.js",
  "./vendor/maplibre/maplibre-gl.css",
  "./vendor/maplibre/maplibre-gl.mjs",
  "./vendor/maplibre/maplibre-gl-worker.mjs",
  "./data/land.geojson",
  "./data/fir.geojson",
  "./data/fir-labels.geojson",
  "./data/airports.geojson",
  "./data/SOURCES.txt",
  "./fonts/OpenSansRegular/0-255.pbf",
  "./fonts/OpenSansBold/0-255.pbf",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./licenses/cc-by-sa-4.0.txt",
  "./licenses/maplibre-bsd-3-clause.txt",
  "./licenses/open-sans-ofl.txt",
  "./licenses/natural-earth.txt",
  "./licenses/ourairports.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("./index.html")))
  );
});
