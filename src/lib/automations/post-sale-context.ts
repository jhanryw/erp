import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type SkipReason =
  | 'anonymous_sale'
  | 'missing_phone'
  | 'exchange_sale'
  | 'no_cashback_generated'
  | 'no_active_cashback'
  | 'no_expiry_date'
  | 'not_in_expiry_window'
  | 'cashback_already_used'
  | 'customer_repurchase_within_30_days'
  | 'already_sent'

export interface PostSaleContext {
  sale_id:        number
  customer_id:    number
  customer_name:  string
  phone:          string | null
  sale_date:      string
  sale_origin:    string | null

  is_anonymous:   boolean
  is_exchange:    boolean

  purchased_again_within_30_days: boolean

  cashback_generated_by_this_sale: number
  cashback_used_in_this_sale:      number

  current_cashback_available: number
  current_cashback_pending:   number

  nearest_cashback_expiry_date:  string | null
  expiry_reminder_wait_until:    string | null

  should_send_cashback_message:    boolean
  should_send_csat:                boolean
  should_schedule_expiry_reminder: boolean
  should_send_expiry_reminder:     boolean

  skip_reasons: {
    cashback_message:  SkipReason | null
    csat:              SkipReason | null
    expiry_reminder:   SkipReason | null
  }

  messages: {
    cashback:        string | null
    csat:            string | null
    expiry_reminder: string | null
  }
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ─── Função principal ─────────────────────────────────────────────────────────

export async function getPostSaleContext(saleId: number): Promise<PostSaleContext | null> {
  const admin = createAdminClient()
  const today = brazilDate()

  // 1. Venda
  const { data: sale } = await (admin as any)
    .from('sales')
    .select('id, customer_id, sale_date, sale_origin, company_id, status')
    .eq('id', saleId)
    .maybeSingle() as { data: { id: number; customer_id: number; sale_date: string; sale_origin: string | null; company_id: number; status: string } | null }

  if (!sale) return null

  // 2. Cliente
  const { data: customer } = await (admin as any)
    .from('customers')
    .select('name, phone, is_anonymous')
    .eq('id', sale.customer_id)
    .maybeSingle() as { data: { name: string; phone: string | null; is_anonymous: boolean } | null }

  const customerName  = customer?.name       ?? ''
  const phone         = customer?.phone      ?? null
  const isAnonymous   = customer?.is_anonymous ?? true

  // 3. is_exchange — crédito de troca usado nesta venda
  const { data: exchangeUse } = await (admin as any)
    .from('cashback_transactions')
    .select('id')
    .eq('type', 'use')
    .eq('used_in_sale_id', saleId)
    .not('exchange_id', 'is', null)
    .maybeSingle() as { data: { id: number } | null }

  const isExchange = !!exchangeUse

  // 4. Cashback gerado por esta venda (earn)
  const { data: earnRows } = await (admin as any)
    .from('cashback_transactions')
    .select('amount')
    .eq('type', 'earn')
    .eq('sale_id', saleId) as { data: { amount: number }[] | null }

  const cashbackGenerated = (earnRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0)

  // 5. Cashback usado nesta venda (use sem exchange_id)
  const { data: useRows } = await (admin as any)
    .from('cashback_transactions')
    .select('amount')
    .eq('type', 'use')
    .eq('used_in_sale_id', saleId) as { data: { amount: number }[] | null }

  const cashbackUsed = (useRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0)

  // 6. Saldo atual (via view — filtra expirados e agrupa por company_id)
  const { data: balance } = await (admin as any)
    .from('v_cashback_balance')
    .select('available_balance, pending_balance')
    .eq('customer_id', sale.customer_id)
    .eq('company_id', sale.company_id)
    .maybeSingle() as { data: { available_balance: number; pending_balance: number } | null }

  const currentAvailable = Number(balance?.available_balance ?? 0)
  const currentPending   = Number(balance?.pending_balance   ?? 0)

  // 7. Nearest expiry date (earn, available, expiry_date IS NOT NULL, > hoje)
  const { data: nearestExpiry } = await (admin as any)
    .from('cashback_transactions')
    .select('expiry_date')
    .eq('customer_id', sale.customer_id)
    .eq('company_id', sale.company_id)
    .eq('type', 'earn')
    .eq('status', 'available')
    .not('expiry_date', 'is', null)
    .gt('expiry_date', today)
    .order('expiry_date', { ascending: true })
    .limit(1)
    .maybeSingle() as { data: { expiry_date: string } | null }

  const nearestExpiryDate    = nearestExpiry?.expiry_date ?? null
  const expiryReminderWaitUntil = nearestExpiryDate ? addDays(nearestExpiryDate, -5) : null

  // 8. Recompra dentro de 30 dias (ignora própria venda e canceladas/devolvidas)
  const saleDate30     = addDays(sale.sale_date, 30)
  const { data: repurchase } = await (admin as any)
    .from('sales')
    .select('id')
    .eq('customer_id', sale.customer_id)
    .neq('id', saleId)
    .gt('sale_date', sale.sale_date)
    .lte('sale_date', saleDate30)
    .not('status', 'in', '("cancelled","returned")')
    .limit(1)
    .maybeSingle() as { data: { id: number } | null }

  const purchasedAgain = !!repurchase

  // 9. Idempotência — eventos já enviados para este sale_id
  const { data: sentEvents } = await (admin as any)
    .from('post_sale_automation_events')
    .select('event_type')
    .eq('sale_id', saleId)
    .in('event_type', ['cashback_message_sent', 'csat_sent', 'expiry_reminder_sent']) as { data: { event_type: string }[] | null }

  const alreadySent = new Set((sentEvents ?? []).map((e) => e.event_type))

  // ─── Flags e skip_reasons ─────────────────────────────────────────────────

  let cashbackSkip: SkipReason | null = null
  if (isAnonymous)           cashbackSkip = 'anonymous_sale'
  else if (!phone)           cashbackSkip = 'missing_phone'
  else if (isExchange)       cashbackSkip = 'exchange_sale'
  else if (!cashbackGenerated) cashbackSkip = 'no_cashback_generated'
  else if (alreadySent.has('cashback_message_sent')) cashbackSkip = 'already_sent'

  let csatSkip: SkipReason | null = null
  if (isAnonymous) csatSkip = 'anonymous_sale'
  else if (!phone) csatSkip = 'missing_phone'
  else if (alreadySent.has('csat_sent')) csatSkip = 'already_sent'

  let expirySkip: SkipReason | null = null
  if (isAnonymous)                  expirySkip = 'anonymous_sale'
  else if (!phone)                  expirySkip = 'missing_phone'
  else if (isExchange)              expirySkip = 'exchange_sale'
  else if (!nearestExpiryDate)      expirySkip = 'no_expiry_date'
  else if (currentAvailable <= 0)   expirySkip = 'no_active_cashback'
  else if (purchasedAgain)          expirySkip = 'customer_repurchase_within_30_days'
  else if (alreadySent.has('expiry_reminder_sent')) expirySkip = 'already_sent'
  else if (
    expiryReminderWaitUntil &&
    (today < expiryReminderWaitUntil || today > nearestExpiryDate)
  )                                 expirySkip = 'not_in_expiry_window'

  const shouldSendCashback  = cashbackSkip === null
  const shouldSendCsat      = csatSkip === null
  const shouldScheduleExpiry = (
    !isAnonymous &&
    !!phone &&
    !isExchange &&
    !!nearestExpiryDate &&
    currentAvailable > 0 &&
    !alreadySent.has('expiry_reminder_sent')
  )
  const shouldSendExpiry = expirySkip === null

  // ─── Mensagens prontas ────────────────────────────────────────────────────

  const name = customerName.split(' ')[0] || customerName

  const cashbackMsg = shouldSendCashback
    ? `Olá, ${name}! 🎉 Sua compra na Santtorini gerou ${formatCurrency(cashbackGenerated)} em cashback. Esse valor fica disponível na sua conta e pode ser usado nas próximas compras. Obrigada pela preferência! 💜`
    : null

  const csatMsg = shouldSendCsat
    ? `Olá, ${name}! Como foi sua experiência na Santtorini? Sua opinião é muito importante para nós. Responda com uma nota de 1 a 5 — sendo 1 ruim e 5 excelente. 😊`
    : null

  let expiryMsg: string | null = null
  if (shouldSendExpiry && nearestExpiryDate && currentAvailable > 0) {
    const daysLeft = Math.ceil(
      (new Date(nearestExpiryDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
    )
    expiryMsg = `${name}, seu cashback de ${formatCurrency(currentAvailable)} na Santtorini expira em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}! Aproveite antes que vença. 💜`
  }

  return {
    sale_id:        sale.id,
    customer_id:    sale.customer_id,
    customer_name:  customerName,
    phone,
    sale_date:      sale.sale_date,
    sale_origin:    sale.sale_origin,

    is_anonymous:   isAnonymous,
    is_exchange:    isExchange,

    purchased_again_within_30_days: purchasedAgain,

    cashback_generated_by_this_sale: cashbackGenerated,
    cashback_used_in_this_sale:      cashbackUsed,

    current_cashback_available: currentAvailable,
    current_cashback_pending:   currentPending,

    nearest_cashback_expiry_date:  nearestExpiryDate,
    expiry_reminder_wait_until:    expiryReminderWaitUntil,

    should_send_cashback_message:    shouldSendCashback,
    should_send_csat:                shouldSendCsat,
    should_schedule_expiry_reminder: shouldScheduleExpiry,
    should_send_expiry_reminder:     shouldSendExpiry,

    skip_reasons: {
      cashback_message: cashbackSkip,
      csat:             csatSkip,
      expiry_reminder:  expirySkip,
    },

    messages: {
      cashback:        cashbackMsg,
      csat:            csatMsg,
      expiry_reminder: expiryMsg,
    },
  }
}
