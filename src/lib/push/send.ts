import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'

// VAPID configurado uma vez no módulo (reutilizado entre chamadas)
// As envs são checadas em runtime — não lançam em build/import
function getWebPush() {
  const subject = process.env.VAPID_SUBJECT
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY

  if (!subject || !publicKey || !privateKey) {
    console.error('[Push] VAPID não configurado — defina VAPID_SUBJECT, NEXT_PUBLIC_VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.')
    return null
  }

  webpush.setVapidDetails(subject, publicKey, privateKey)
  return webpush
}

export function isVapidConfigured(): boolean {
  return Boolean(process.env.VAPID_SUBJECT && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

interface Subscription {
  id:         number
  endpoint:   string
  p256dh:     string
  auth:       string
  company_id: number
  user_id:    string
}

interface PushPayload {
  title: string
  body:  string
  url:   string
  icon:  string
}

/** Envia para um conjunto de assinaturas já resolvidas, registrando cada tentativa em push_send_logs. */
async function deliverToSubscriptions(subs: Subscription[], payload: PushPayload): Promise<number> {
  const wp = getWebPush()
  if (!wp) return 0
  if (!subs.length) return 0

  const admin = createAdminClient()
  const body = JSON.stringify(payload)
  let delivered = 0

  await Promise.allSettled(
    subs.map(async (sub) => {
      const logBase = {
        subscription_id: sub.id,
        company_id:      sub.company_id,
        user_id:         sub.user_id,
        endpoint:         sub.endpoint,
      }

      try {
        await wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        )
        delivered++

        await (admin as any).from('push_subscriptions')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', sub.id)

        await (admin as any).from('push_send_logs').insert({
          ...logBase,
          success:     true,
          status_code: 201,
        })
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode ?? null
        const message = (err as { body?: string; message?: string }).body
          ?? (err as { message?: string }).message
          ?? 'Erro desconhecido no envio'

        console.error(`[Push] Falha ao enviar para subscription ${sub.id} (status ${status}):`, message)

        // 404/410 = browser removeu a assinatura — desativa para não tentar de novo
        if (status === 410 || status === 404) {
          await (admin as any).from('push_subscriptions')
            .update({ active: false })
            .eq('id', sub.id)
        }

        await (admin as any).from('push_send_logs').insert({
          ...logBase,
          success:       false,
          status_code:   status,
          error_message: String(message).slice(0, 500),
        })
      }
    })
  )

  return delivered
}

export interface SendPushOptions {
  companyId:  number
  roles?:     string[]   // default: ['admin']
  title:      string
  body:       string
  url:        string
  icon?:      string
}

export async function sendPushNotification({
  companyId,
  roles = ['admin'],
  title,
  body,
  url,
  icon = '/icons/icon-192.png',
}: SendPushOptions): Promise<void> {
  const admin = createAdminClient()

  const { data: subs } = await (admin as any)
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, company_id, user_id')
    .eq('company_id', companyId)
    .eq('active', true)
    .in('role', roles) as { data: Subscription[] | null }

  await deliverToSubscriptions(subs ?? [], { title, body, url, icon })
}

export interface SendTestPushOptions {
  userId: string
  title:  string
  body:   string
  url:    string
  icon?:  string
}

/** Envia um push de teste real (pela infraestrutura completa) só para as assinaturas ativas do próprio usuário. */
export async function sendTestPush({
  userId,
  title,
  body,
  url,
  icon = '/icons/icon-192.png',
}: SendTestPushOptions): Promise<{ sent: number; total: number }> {
  const admin = createAdminClient()

  const { data: subs } = await (admin as any)
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, company_id, user_id')
    .eq('user_id', userId)
    .eq('active', true) as { data: Subscription[] | null }

  const total = subs?.length ?? 0
  const sent = await deliverToSubscriptions(subs ?? [], { title, body, url, icon })
  return { sent, total }
}
