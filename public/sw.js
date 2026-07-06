// Service Worker — Santtorini ERP
// Responsável por receber push notifications e abrir a URL ao clicar.

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try { data = event.data.json() } catch { return }

  const { title = 'Santtorini ERP', body = '', url = '/', icon = '/icons/icon-192.png' } = data

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: '/icons/icon-192.png',
      data: { url },
      requireInteraction: false,
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if ('focus' in client) {
            client.focus()
            if ('navigate' in client) client.navigate(targetUrl)
            return
          }
        }
        return clients.openWindow(targetUrl)
      })
  )
})
