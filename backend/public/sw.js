// Service worker : network-first (évite le contenu périmé après déploiement),
// repli sur le cache hors-ligne, et précache de la coquille applicative pour un
// démarrage instantané / hors-ligne. N'intercepte ni l'API, ni les flux, ni Socket.io.
const CACHE = 'amq-v44';

// Coquille applicative : tout le statique nécessaire au 1er rendu.
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/assets/brand/favicon-32.png', '/assets/brand/icon-192.png',
  '/assets/brand/icon-512.png', '/assets/brand/logo-horizontal-on-dark.png',
  '/bootstrap.js', '/i18n.js', '/sfx.js', '/main.js',
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

// Notifications push : affiche la notif reçue.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || 'AMQTrainer';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/assets/brand/icon-192.png',
    badge: '/assets/brand/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

// Clic sur la notif : focalise un onglet existant (ou en ouvre un) sur l'URL cible.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { if (c.navigate) c.navigate(url).catch(() => {}); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
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
