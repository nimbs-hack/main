const STATIC_CACHE = "nimbs-static-v2";
const TILE_CACHE = "nimbs-tiles-v1";
const MAX_CACHED_TILES = 600;

const STATIC_DATA_URLS = [
  "/",
  "/index.html",
  "/data/site-meta.json",
  "/data/site-terrain.bin",
  "/data/site-soil.bin",
  "/data/site-hillshade.png",
  "/data/site-weather.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.allSettled(
          STATIC_DATA_URLS.map((url) =>
            fetch(url).then((res) => {
              if (res.ok) return cache.put(url, res);
              return undefined;
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== TILE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isMarsTileRequest(url) {
  return (
    (url.hostname === "planetarymaps.usgs.gov" && url.pathname.includes("/cgi-bin/mapserv")) ||
    (url.hostname === "trek.nasa.gov" && url.pathname.includes("/tiles/Mars/"))
  );
}

async function trimTileCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_CACHED_TILES;
  if (excess <= 0) return;
  for (let i = 0; i < excess; i += 1) {
    const key = keys[i];
    if (key) {
      await cache.delete(key);
    }
  }
}

async function handleTileRequest(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.startsWith("image/")) {
      await cache.put(request, response.clone());
      void trimTileCache(cache);
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function handleStaticAsset(request, url) {
  const cache = await caches.open(STATIC_CACHE);

  // Network-first for mutable HTML and manifest metadata so new deploys propagate immediately
  const isNetworkFirst =
    request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/data/site-meta.json" ||
    url.pathname === "/data/site-weather.json";

  if (isNetworkFirst) {
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await cache.match("/index.html");
        if (shell) return shell;
      }
      throw new Error("Offline and not cached");
    }
  }

  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isMarsTileRequest(url)) {
    event.respondWith(handleTileRequest(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js") return;
    event.respondWith(handleStaticAsset(request, url));
  }
});
