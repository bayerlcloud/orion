// Service worker do Orion: abre rápido e com rede ruim.
// assets/ (nome com hash, nunca muda): cache primeiro. Páginas: rede primeiro, cache só se offline.
// /api nunca passa por aqui (dados sempre ao vivo).
const CACHE = 'orion-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/senhas') || url.pathname.startsWith('/wa/')) return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put('/', res.clone()));
      return res;
    }).catch(() => caches.match('/').then(r => r ?? Response.error())));
  }
});
