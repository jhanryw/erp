import { createAdminClient } from '@/lib/supabase/admin'
import { getTodayRevenue } from '@/lib/analytics/todayRevenue'
import { sendPushNotification } from '@/lib/push/send'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export interface NotifyExchangeOptions {
  /** id da venda-filha criada pela troca (destino do link do push) */
  saleId:     number
  companyId:  number
  /** sales.total da venda-filha — já é o valor incremental real a receber (bruto - crédito de troca usado) */
  difference: number
}

/**
 * Notifica os admins da empresa sobre uma troca concluída com venda-filha
 * (peça nova levada) — correção 2026-09-15: antes disso, uma troca sem
 * diferença a pagar disparava `notifyNewSale()` como se fosse uma venda
 * comum, mostrando "Nova venda • R$0,00" — enganoso, já que nenhum
 * dinheiro novo entrou (o valor virou crédito de troca, consumido na
 * hora). `troca/route.ts` passa `skipNewSaleNotification: true` para
 * `createSale()` e chama esta função no lugar.
 *
 * `difference` é o `total` da venda-filha, que já representa exatamente
 * o valor incremental a receber (bruto da mercadoria nova menos o
 * crédito de troca usado) — não recalcula nada, só usa o valor que o RPC
 * já retornou.
 *
 * Idempotente por sale_id, mesmo mecanismo de `notifyNewSale`
 * (`sale_push_notifications`), com a venda-filha como chave.
 */
export async function notifyExchange({ saleId, companyId, difference }: NotifyExchangeOptions): Promise<void> {
  const admin = createAdminClient()

  const { data: claimed, error: claimError } = await (admin as any)
    .from('sale_push_notifications')
    .upsert({ sale_id: saleId }, { onConflict: 'sale_id', ignoreDuplicates: true })
    .select('sale_id')

  if (claimError) {
    console.error(`[Push] Falha ao registrar claim de idempotência da troca (venda ${saleId}):`, claimError.message)
    return
  }

  if (!claimed?.length) return

  const { revenue } = await getTodayRevenue(companyId)

  const body = difference > 0
    ? `Diferença: ${currency.format(difference)} • Faturamento hoje: ${currency.format(revenue)}`
    : `Sem diferença a pagar • Faturamento hoje: ${currency.format(revenue)}`

  await sendPushNotification({
    companyId,
    roles: ['admin'],
    title: 'Troca realizada • Santtorini',
    body,
    url:   `/vendas/${saleId}`,
  })
}
