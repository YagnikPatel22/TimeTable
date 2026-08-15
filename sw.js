// Ephemeral — service worker
// Gives notifications actionable buttons (Snooze) and keeps them working
// as long as the browser is running, even if this tab isn't focused.
// NOTE: this does NOT deliver alerts if the browser itself is fully quit —
// that requires a push server (VAPID + backend), which is a separate project.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'SHOW_NOTIFICATION') return;
  const { title, body, tag, data, actions, requireInteraction } = msg.payload;
  self.registration.showNotification(title, {
    body,
    tag,
    data,
    actions: actions || [],
    requireInteraction: !!requireInteraction
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  if (event.action === 'snooze') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        if (list.length > 0) {
          list[0].postMessage({ type: 'SNOOZE_ENTRY', entryId: data.entryId });
          return list[0].focus();
        }
        return self.clients.openWindow('./');
      })
    );
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
