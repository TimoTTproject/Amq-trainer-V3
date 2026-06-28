// Service worker : network-first (évite le contenu périmé après déploiement),
// repli sur le cache hors-ligne, et précache de la coquille applicative pour un
// démarrage instantané / hors-ligne. N'intercepte ni l'API, ni les flux, ni Socket.io.
const CACHE = 'amq-v2';

// Coquille applicative : tout le statique nécessaire au 1er rendu.
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/icon.svg',
  '/sfx.js', '/tower.js', '/admin.js', '/playlist.js', '/gacha.js',
  '/catalog.js', '/community.js', '/main.js', '/anime-autocomplete.js', '/mp-client.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (
    e.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/socket.io')
  ) {
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        // Hors-ligne sur une navigation : sert la coquille en cache.
        if (e.request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      })
  );
});
