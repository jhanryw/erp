import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'

// VAPID configurado uma vez no módulo (reutilizado entre chamadas)
// As envs são checadas em runtime — não lançam em build/import
function getWebPush() {
  const subject = process.env.VAPID_SUBJECT
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY

  if (!subject || !publicKey || !privateKey) {
    return null
  }

  webpush.setVapidDetails(subject, publicKey, privateKey)
  return webpush
}

export interface SendPushOptions {
  companyId:  number
  roles?:     string[]   // default: ['admin']
  title:      string
  body:       string
  url:        string
  icon?:      string
}

interface Subscription {
  id:       number
  endpoint: string
  p256dh:   string
  auth:     string
}

export async function sendPushNotification({
  companyId,
  roles = ['admin'],
  title,
  body,
  url,
  icon = '/icons/icon-192.png',
}: SendPushOptions): Promise<void> {
  const wp = getWebPush()
  if (!wp) return // VAPID não configurado — silencioso

  const admin = createAdminClient()

  const { data: subs } = await (admin as any)
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('company_id', companyId)
    .eq('active', true)
    .in('role', roles) as { data: Subscription[] | null }

  if (!subs?.length) return

  const payload = JSON.stringify({ title, body, url, icon })

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        )
        // Atualiza last_seen_at após envio bem-sucedido
        await (admin as any)
          .from('push_subscriptions')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', sub.id)
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode
        // 410 Gone / 404 = browser removeu a assinatura
        if (status === 410 || status === 404) {
          await (admin as any)
            .from('push_subscriptions')
            .update({ active: false })
            .eq('id', sub.id)
        }
      }
    })
  )
}
