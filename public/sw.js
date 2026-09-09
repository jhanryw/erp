// Service Worker — Santtorini ERP
// Responsável por receber push notifications e abrir a URL ao clicar.

// Assume controle imediatamente após instalar/ativar — sem isso, o SW novo só
// entra em vigor depois que todas as abas forem fechadas e reabertas, o que no
// PWA instalado do iPhone pode levar dias e mascarar correções já publicadas.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim())
})

// O navegador pode invalidar/rotacionar a subscription sozinho (ex: expiração
// de chave). Sem esse listener, o app nunca fica sabendo e o push para de
// funcionar silenciosamente até o usuário reativar manualmente.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const applicationServerKey = event.oldSubscription?.options?.applicationServerKey
        const newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })

        const key = newSubscription.getKey('p256dh')
        const auth = newSubscription.getKey('auth')

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: newSubscription.endpoint,
            p256dh: key ? btoa(String.fromCharCode(...new Uint8Array(key))) : '',
            auth: auth ? btoa(String.fromCharCode(...new Uint8Array(auth))) : '',
          }),
        })
      } catch {
        // Silencioso — se falhar, o usuário pode renovar manualmente em Configurações > Notificações
      }
    })()
  )
})

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
