export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { validateStockForSale, validateProductsActive, checkSalePrices, createSale } from '@/services/vendas.service'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushMultipleVariantStocksToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

async function sendSaleWebhook(
  admin: SupabaseClient,
  saleId: number,
  customerId: number,
  companyId: number,
  webhookUrl: string,
): Promise<void> {
  const { data: existing } = await admin
    .from('webhook_log')
    .select('id')
    .eq('sale_id', saleId)
    .eq('event_type', 'sale_confirmed')
    .eq('status', 'sent')
    .maybeSingle()

  if (existing) return

  const [{ data: saleRow }, { data: customer }] = await Promise.all([
    admin.from('sales').select('id, total, sale_date').eq('id', saleId).single(),
    admin.from('customers').select('name, phone').eq('id', customerId).single(),
  ])

  const payload = {
    sale_id:       saleId,
    customer_name: customer?.name ?? null,
    customer_phone: customer?.phone ?? null,
    total:         saleRow?.total ?? null,
    sale_date:     saleRow?.sale_date ?? null,
  }

  let status: 'sent' | 'failed' = 'failed'
  let httpStatus: number | null = null
  let errorMessage: string | null = null

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    httpStatus = res.status
    status = res.ok ? 'sent' : 'failed'
    if (!res.ok) errorMessage = `HTTP ${res.status}`
  } catch (err) {
    errorMessage = String(err)
  }

  await admin.from('webhook_log').insert({
    event_type:    'sale_confirmed',
    sale_id:       saleId,
    company_id:    companyId,
    payload,
    webhook_url:   webhookUrl,
    status,
    http_status:   httpStatus,
    error_message: errorMessage,
  })
}

const itemSchema = z.object({
  product_variation_id: z.number().int().positive(),
  quantity:             z.number().int().positive(),
  unit_price:           z.number().positive(),
  unit_cost:            z.number().min(0),
  discount_amount:      z.number().min(0).default(0),
})

const paymentEntrySchema = z.object({
  method:          z.enum(['pix', 'cash', 'credit_card', 'debit_card']),
  amount_tendered: z.number().positive(),
  change_amount:   z.number().min(0).default(0),
  change_method:   z.enum(['cash', 'pix']).optional(),
  net_amount:      z.number().positive(),
  installments:    z.number().int().min(1).max(12).default(1),
  card_brand:      z.string().optional(),
  acquirer:        z.string().optional(),
  metadata:        z.record(z.unknown()).default({}),
})

const schema = z.object({
  customer_id:      z.number().int().positive(),
  // Legado (campo único) — pode estar presente mesmo no novo fluxo como método dominante derivado
  payment_method:   z.enum(['pix', 'card', 'cash', 'credit_card', 'debit_card']).optional(),
  // Novo fluxo multi-pagamento
  payments:         z.array(paymentEntrySchema).min(1).optional(),
  delivery_mode:    z.enum(['pickup', 'delivery']).default('delivery'),
  sale_origin:      z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  // 'use' → aplica saldo existente, não gera novo cashback
  // 'accumulate' → não usa saldo, gera cashback normalmente
  cashback_action:  z.enum(['use', 'accumulate']).default('accumulate'),
  discount_amount:  z.number().min(0).default(0),
  surcharge_amount: z.number().min(0).default(0),
  cashback_used:    z.number().min(0).default(0),
  shipping_charged: z.number().min(0).default(0),
  notes:            z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  items:            z.array(itemSchema).min(1),
  cash_session_id:  z.number().int().positive().nullable().optional(),
}).refine(
  (d) => d.payments != null || d.payment_method != null,
  { message: 'Informe payment_method ou payments[].' }
)

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  try {
    // Regra 1: produtos/variações devem estar ativos (hard block para qualquer role)
    const activeCheck = await validateProductsActive(parsed.data.items, user.company_id)
    if (!activeCheck.ok) return NextResponse.json({ error: activeCheck.error }, { status: activeCheck.status })

    // Regra 2: validar estoque disponível
    const stockCheck = await validateStockForSale(parsed.data.items, user.company_id)
    if (!stockCheck.ok) return NextResponse.json({ error: stockCheck.error }, { status: stockCheck.status })

    // Regra 3: preço abaixo do custo — bloqueia usuario, avisa gerente/admin
    const priceCheck = checkSalePrices(parsed.data.items)
    if (priceCheck.warnings.length > 0 && user.role === 'usuario') {
      return NextResponse.json(
        { error: `Venda com margem negativa requer aprovação de gerente. ${priceCheck.warnings[0]}` },
        { status: 403 }
      )
    }

    // Derivar payment_method do método dominante (maior net_amount) quando payments[] fornecido
    let effectivePaymentMethod = parsed.data.payment_method ?? 'pix'
    if (parsed.data.payments && parsed.data.payments.length > 0) {
      const dominant = parsed.data.payments.reduce((a, b) => b.net_amount > a.net_amount ? b : a)
      effectivePaymentMethod = dominant.method
    }

    // Garantir coerência: se cashback_action === 'use', cashback_used pode ser > 0;
    // se 'accumulate', forçar cashback_used = 0 independente do que foi enviado.
    const saleData = {
      ...parsed.data,
      payment_method:  effectivePaymentMethod as 'pix' | 'card' | 'cash' | 'credit_card' | 'debit_card',
      cashback_used:   parsed.data.cashback_action === 'accumulate' ? 0 : parsed.data.cashback_used,
    }

    // Criar venda via service (sale + itens + estoque + finance)
    const result = await createSale({ ...saleData, systemUserId: user.id, cashSessionId: parsed.data.cash_session_id ?? null })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    const sale = result.data
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'create', resource: 'sale',
      resourceId: sale.id, detail: sale.sale_number,
    })

    // Sincronizar estoque para Nuvemshop (não-fatal, fire-and-forget)
    const soldVariationIds = saleData.items.map((i) => i.product_variation_id)
    pushMultipleVariantStocksToNuvemshop(soldVariationIds, { eventType: 'stock_push_erp' }).catch(
      (err) => console.error('[POST /api/vendas] Erro na sincronização Nuvemshop', err)
    )

    const admin = createAdminClient()

    // Webhook n8n pós-venda (não-fatal, fire-and-forget)
    const n8nUrl = process.env.N8N_WEBHOOK_URL
    if (n8nUrl) {
      sendSaleWebhook(admin, sale.id, saleData.customer_id, user.company_id, n8nUrl).catch(
        (err) => console.error('[POST /api/vendas] Webhook n8n error', err)
      )
    }

    // Criar envio automaticamente após a venda
    const { delivery_mode } = saleData
    const shipmentStatus = delivery_mode === 'pickup' ? 'aguardando_retirada' : 'aguardando_confirmacao'
    await (admin as any)
      .from('shipments')
      .insert({
        order_id:      sale.id,
        customer_id:   saleData.customer_id,
        delivery_mode,
        status:        shipmentStatus,
        notes:         saleData.notes ?? null,
        company_id:    user.company_id,
      })
    // Erro no shipment é não-fatal: a venda já foi criada

    return NextResponse.json({
      sale,
      ...(priceCheck.warnings.length > 0 ? { warnings: priceCheck.warnings } : {}),
    })
  } catch (err) {
    logError({
      route: 'POST /api/vendas',
      err,
      context: {
        user_id:     user.id,
        company_id:  user.company_id,
        items_count: parsed.data.items.length,
        customer_id: parsed.data.customer_id,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
