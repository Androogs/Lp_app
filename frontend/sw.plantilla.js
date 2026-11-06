// Service worker: la interfaz (HTML, CSS, JS, iconos) se guarda en caché para abrir rápido e instalarse como PWA.
// Las peticiones a /api nunca se cachean: los datos siempre vienen del servidor.
const CACHE = 'palmira-v1';
const ESTATICOS = ['/', '/index.html', '/css/app.css?v=8', '/css/marketing.css?v=8', '/css/asistente.css?v=8', '/css/inicio.css?v=8', '/icons/tino.svg', '/js/app.js?v=8', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo-palmira.webp', '/icons/isotipo.svg', '/vendor/zxing.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ESTATICOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/comprobante/')) return; // siempre red
  // Red primero con respaldo en caché (así los cambios de la interfaz llegan de inmediato).
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((resp) => {
      if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return resp;
    }).catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});

// Avisos de Tino: al tocar la notificación se enfoca la pestaña de la aplicación (y se abre Tino) o se abre una nueva.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || '/#/inicio';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
    for (const c of lista) {
      if (new URL(c.url).origin === location.origin && 'focus' in c) { c.postMessage({ tipo: 'tino-abrir' }); return c.focus(); }
    }
    return self.clients.openWindow(destino + (destino.includes('?') ? '&' : '?') + 'tino=1');
  }));
});
