const BUILD_ID = '__ANYCAST_LAB_BUILD_ID__';
const PRECACHE_FILES = JSON.parse('__ANYCAST_LAB_PRECACHE_URLS__');
const CACHE_PREFIX = 'anycast-lab-';
const PRECACHE = `${CACHE_PREFIX}${BUILD_ID}`;
const APP_ROOT = new URL('./', self.registration.scope).href;
const INDEX_URL = new URL('index.html', self.registration.scope).href;
const PRECACHE_URLS = new Set(PRECACHE_FILES.map((fileName) => new URL(fileName, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    const requests = [...PRECACHE_URLS].map((url) => new Request(url, { cache: 'reload' }));
    await cache.addAll(requests);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== PRECACHE)
      .map((cacheName) => caches.delete(cacheName)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => undefined);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }

  // Native VM releases are large, integrity-pinned, and independently
  // versioned. Their runtime loader owns fetching and persistence decisions.
  if (url.pathname.startsWith(new URL('runtime/', self.registration.scope).pathname)) return;

  if (PRECACHE_URLS.has(url.href) || url.pathname.startsWith(new URL('assets/', self.registration.scope).pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function navigate(event) {
  try {
    const response = await event.preloadResponse || await fetch(event.request);
    if (isCacheable(response)) {
      const cache = await caches.open(PRECACHE);
      await cache.put(APP_ROOT, response.clone());
    }
    if (response.status >= 500) return cachedShell(response);
    return response;
  } catch {
    return cachedShell();
  }
}

async function cachedShell(networkResponse) {
  const cache = await caches.open(PRECACHE);
  const cached = await cache.match(APP_ROOT, { ignoreVary: true })
    || await cache.match(INDEX_URL, { ignoreVary: true });
  return cached || networkResponse || new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101114"><title>Anycast Lab is offline</title><style>html{color-scheme:dark;font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;background:#0c0d10;color:#e9e9ed}body{display:grid;min-height:100vh;margin:0;place-items:center}main{max-width:34rem;padding:2rem}h1{font-size:1.4rem}p{color:#9298a5;line-height:1.5}</style></head><body><main><h1>Anycast Lab is offline</h1><p>Reconnect once to finish installing the lab.</p></main></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(PRECACHE);
  // Vite preview and several CDNs add `Vary: Origin` to static assets. These
  // entries are scoped, same-origin, and content-hashed, so matching without
  // that transport-specific header is both safe and required for offline use.
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) await cache.put(request, response.clone());
  return response;
}

function isCacheable(response) {
  return response.ok && (response.type === 'basic' || response.type === 'default');
}
