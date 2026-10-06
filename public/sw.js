// Service worker: instalacja jako PWA + powiadomienia push. Bez cache, zawsze sieć.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'CC Panel', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'CC Panel', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/#/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
