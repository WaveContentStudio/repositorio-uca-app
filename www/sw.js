// Service worker del Repositorio UCA: deja la app funcionando sin conexión.
// Si cambiás archivos de la app, subí la versión (v3 -> v4) para que se actualicen las instalaciones.
const CACHE = 'repo-uca-v4';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'supabase.js', 'repo-api.js', 'local-api.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) {
    if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {   // tipografías
      e.respondWith(caches.open(CACHE).then(c => c.match(r).then(hit => {
        const net = fetch(r).then(res => { c.put(r, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })));
    }
    return;   // Supabase y todo lo demás pasa directo a la red
  }
  // La página y config.js: primero la red (así los cambios se ven enseguida); sin internet, la copia guardada
  if (r.mode === 'navigate' || u.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(r.mode === 'navigate' ? 'index.html' : r, c)); return res; })
      .catch(() => caches.match(r.mode === 'navigate' ? 'index.html' : r)));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); return res; })));
});
