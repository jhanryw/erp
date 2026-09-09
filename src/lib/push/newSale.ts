import { createAdminClient } from '@/lib/supabase/admin'
import { getTodayRevenue } from '@/lib/analytics/todayRevenue'
import { sendPushNotification } from '@/lib/push/send'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export interface NotifyNewSaleOptions {
  saleId:    number
  companyId: number
  total:     number
}

/**
 * Notifica os admins da empresa sobre uma venda recém-persistida com sucesso.
 * Único ponto de disparo — chamado pelos dois lugares que efetivamente
 * inserem em `sales` (createSale() em vendas.service.ts, usado por PDV/troca/
 * atacado; e o webhook de pedidos da Nuvemshop). Nunca chamar para vendas
 * canceladas/estornadas — RPCs de cancelamento/devolução não criam venda,
 * só alteram status de uma já existente, então não passam por aqui.
 *
 * Idempotente por sale_id via public.sale_push_notifications: um INSERT
 * único funciona como claim — se a linha já existe, o envio é pulado.
 */
export async function notifyNewSale({ saleId, companyId, total }: NotifyNewSaleOptions): Promise<void> {
  const admin = createAdminClient()

  const { data: claimed, error: claimError } = await (admin as any)
    .from('sale_push_notifications')
    .upsert({ sale_id: saleId }, { onConflict: 'sale_id', ignoreDuplicates: true })
    .select('sale_id')

  if (claimError) {
    console.error(`[Push] Falha ao registrar claim de idempotência da venda ${saleId}:`, claimError.message)
    return
  }

  // ignoreDuplicates faz o upsert não retornar linha quando já existia —
  // ou seja, já foi notificada antes.
  if (!claimed?.length) return

  const { revenue } = await getTodayRevenue(companyId)

  await sendPushNotification({
    companyId,
    roles: ['admin'],
    title: 'Nova venda • Santtorini',
    body:  `${currency.format(total)} • Faturamento hoje: ${currency.format(revenue)}`,
    url:   `/vendas/${saleId}`,
  })
}
