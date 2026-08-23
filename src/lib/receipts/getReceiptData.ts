// Comprovante não fiscal / trocas — leitura consolidada de uma venda para
// gerar o comprovante (impressão interna) ou a página pública de verificação.
//
// NÃO é documento fiscal — nunca lê/monta nada de fiscal_documents, Focus,
// resolveFiscalDocumentType. Nunca expõe custo/margem (unit_cost,
// fee_amount, net_amount, acquirer ficam de fora de tudo aqui).
//
// Duas entradas, um único formato de saída (ReceiptData):
//   - getReceiptByToken(token)                    → rota pública /comprovante/[token], SEM company_id do chamador (o token já identifica exatamente 1 venda)
//   - getReceiptForSalePrint({ saleId, companyId }) → impressão interna, autenticada, sempre escopada por company_id da sessão
//
// Mesmo padrão de queries em etapas (sem embed ambíguo) já usado em
// vendas/[id]/troca/page.tsx e vendas/[id]/imprimir/page.tsx — cada relação
// é buscada separadamente para nenhuma derrubar as outras.

import { createAdminClient } from '@/lib/supabase/admin'
import { logQueryError, type PgErrorLike } from '@/lib/errors/pgResult'
import { computeExchangeEligibility } from './receiptEligibility'

export interface ReceiptItem {
  sale_item_id: number
  product_name: string
  variation_label: string | null
  quantity: number
  unit_price: number
  total_price: number
  already_returned: number
  available_to_return: number
}

export interface ReceiptPayment {
  method: string
  amount_tendered: number
  change_amount: number
  change_method: string | null
}

export interface ReceiptTotals {
  subtotal: number
  discount_amount: number
  surcharge_amount: number
  shipping_charged: number
  cashback_used: number
  total: number
}

export interface ReceiptData {
  sale: {
    id: number
    company_id: number
    sale_number: string
    receipt_token: string
    sale_date: string
    created_at: string
    status: string
  }
  store: { name: string }
  items: ReceiptItem[]
  payments: ReceiptPayment[]
  totals: ReceiptTotals
  /** Só populado na impressão interna — nunca na página pública de verificação. */
  customer: { name: string } | null
}

const ROUTE = 'getReceiptData'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Formato válido de UUID v4 — barato de checar antes de qualquer query ao banco. */
export function isValidReceiptToken(token: string): boolean {
  return UUID_RE.test(token)
}

async function buildReceipt(
  admin: ReturnType<typeof createAdminClient>,
  saleBase: {
    id: number
    company_id: number
    sale_number: string
    receipt_token: string
    sale_date: string
    created_at: string
    status: string
    customer_id: number | null
    payment_method: string
    subtotal: number
    discount_amount: number
    surcharge_amount: number
    shipping_charged: number
    cashback_used: number
    total: number
  },
  includeCustomer: boolean,
): Promise<ReceiptData> {
  const stage2 = await Promise.all([
    (admin as any)
      .from('company_fiscal_settings')
      .select('nome_fantasia, razao_social')
      .eq('company_id', saleBase.company_id)
      .maybeSingle(),
    admin.from('companies').select('name').eq('id', saleBase.company_id).maybeSingle(),
    admin
      .from('sale_items')
      .select('id, quantity, unit_price, total_price, product_variation_id')
      .eq('sale_id', saleBase.id),
    (admin as any)
      .from('sale_payments')
      .select('method, amount_tendered, change_amount, change_method')
      .eq('sale_id', saleBase.id),
    (admin as any)
      .from('exchange_items')
      .select('sale_item_id, quantity_returned, exchanges!inner(original_sale_id, status)')
      .eq('exchanges.original_sale_id', saleBase.id)
      .eq('exchanges.status', 'completed'),
    includeCustomer && saleBase.customer_id
      ? admin.from('customers').select('name').eq('id', saleBase.customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  const [
    { data: fiscalSettings, error: fiscalSettingsError },
    { data: company, error: companyError },
    { data: saleItems, error: saleItemsError },
    { data: payments, error: paymentsError },
    { data: exchangeItems, error: exchangeItemsError },
    { data: customer, error: customerError },
  ] = stage2 as any[]

  logQueryError(fiscalSettingsError as PgErrorLike, `${ROUTE} (fiscal_settings)`, { sale_id: saleBase.id })
  logQueryError(companyError as PgErrorLike, `${ROUTE} (company)`, { sale_id: saleBase.id })
  logQueryError(saleItemsError as PgErrorLike, `${ROUTE} (sale_items)`, { sale_id: saleBase.id })
  logQueryError(paymentsError as PgErrorLike, `${ROUTE} (sale_payments)`, { sale_id: saleBase.id })
  logQueryError(exchangeItemsError as PgErrorLike, `${ROUTE} (exchange_items)`, { sale_id: saleBase.id })
  logQueryError(customerError as PgErrorLike, `${ROUTE} (customer)`, { sale_id: saleBase.id })

  // ── Etapa 3 — nomes de produto/variação (mesmo padrão da página de troca) ──
  const items = (saleItems ?? []) as any[]
  const variationIds = [...new Set(items.map((i) => i.product_variation_id))]

  const { data: productVariations, error: pvError } = variationIds.length
    ? await admin.from('product_variations').select('id, sku_variation, product_id').in('id', variationIds)
    : { data: [] as any[], error: null }
  logQueryError(pvError as PgErrorLike, `${ROUTE} (product_variations)`, { sale_id: saleBase.id })

  const productIds = [...new Set((productVariations ?? []).map((v: any) => v.product_id))]

  const [{ data: products, error: productsError }, { data: attrs, error: attrsError }] = await Promise.all([
    productIds.length
      ? admin.from('products').select('id, name').in('id', productIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    variationIds.length
      ? (admin as any)
          .from('product_variation_attributes')
          .select('product_variation_id, variation_types:variation_type_id(name), variation_values:variation_value_id(value)')
          .in('product_variation_id', variationIds)
      : Promise.resolve({ data: [] as any[], error: null }),
  ])
  logQueryError(productsError as PgErrorLike, `${ROUTE} (products)`, { sale_id: saleBase.id })
  logQueryError(attrsError as PgErrorLike, `${ROUTE} (variation_attributes)`, { sale_id: saleBase.id })

  const productsById = new Map((products ?? []).map((p: any) => [p.id, p]))
  const variationsById = new Map((productVariations ?? []).map((v: any) => [v.id, v]))
  const attrsByVariation = new Map<number, string[]>()
  for (const a of (attrs ?? []) as any[]) {
    const typeName = Array.isArray(a.variation_types) ? a.variation_types[0]?.name : a.variation_types?.name
    const value = Array.isArray(a.variation_values) ? a.variation_values[0]?.value : a.variation_values?.value
    if (!value) continue
    const list = attrsByVariation.get(a.product_variation_id) ?? []
    list.push(typeName ? `${typeName}: ${value}` : String(value))
    attrsByVariation.set(a.product_variation_id, list)
  }

  const eligibility = computeExchangeEligibility(
    items.map((i) => ({ id: i.id, quantity: i.quantity })),
    (exchangeItems ?? []) as { sale_item_id: number; quantity_returned: number }[],
  )
  const eligibilityById = new Map(eligibility.map((e) => [e.sale_item_id, e]))

  const receiptItems: ReceiptItem[] = items.map((item) => {
    const variation = variationsById.get(item.product_variation_id) as any
    const product = variation ? productsById.get(variation.product_id) : null
    const elig = eligibilityById.get(item.id)
    return {
      sale_item_id: item.id,
      product_name: (product as any)?.name ?? 'Produto',
      variation_label: variation ? (attrsByVariation.get(variation.id)?.join(' · ') ?? null) : null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
      already_returned: elig?.already_returned ?? 0,
      available_to_return: elig?.available_to_return ?? item.quantity,
    }
  })

  const receiptPayments: ReceiptPayment[] =
    payments && payments.length > 0
      ? payments.map((p: any) => ({
          method: p.method,
          amount_tendered: p.amount_tendered,
          change_amount: p.change_amount,
          change_method: p.change_method,
        }))
      : [{ method: saleBase.payment_method, amount_tendered: saleBase.total, change_amount: 0, change_method: null }]

  const storeName =
    (fiscalSettings as any)?.nome_fantasia ||
    (fiscalSettings as any)?.razao_social ||
    (company as any)?.name ||
    'Santtorini'

  return {
    sale: {
      id: saleBase.id,
      company_id: saleBase.company_id,
      sale_number: saleBase.sale_number,
      receipt_token: saleBase.receipt_token,
      sale_date: saleBase.sale_date,
      created_at: saleBase.created_at,
      status: saleBase.status,
    },
    store: { name: storeName },
    items: receiptItems,
    payments: receiptPayments,
    totals: {
      subtotal: saleBase.subtotal,
      discount_amount: saleBase.discount_amount,
      surcharge_amount: saleBase.surcharge_amount,
      shipping_charged: saleBase.shipping_charged,
      cashback_used: saleBase.cashback_used,
      total: saleBase.total,
    },
    customer: includeCustomer && customer ? { name: (customer as any).name } : null,
  }
}

const SALE_BASE_COLUMNS =
  'id, company_id, sale_number, receipt_token, sale_date, created_at, status, customer_id, payment_method, subtotal, discount_amount, surcharge_amount, shipping_charged, cashback_used, total'

/**
 * Rota pública /comprovante/[token]. NUNCA recebe/filtra por company_id do
 * chamador — o token já identifica exatamente 1 venda (UNIQUE,
 * não-sequencial, ver 20260830_sales_receipt_token.sql). Não inclui dados de
 * cliente no retorno (includeCustomer=false) — a página pública nunca deve
 * renderizar nome/CPF de cliente (ver requisito 3 do comprovante).
 */
export async function getReceiptByToken(token: string): Promise<ReceiptData | null> {
  if (!isValidReceiptToken(token)) return null

  const admin = createAdminClient()
  const { data: saleBase, error } = await admin
    .from('sales')
    .select(SALE_BASE_COLUMNS)
    .eq('receipt_token', token)
    .maybeSingle() as unknown as { data: any; error: PgErrorLike | null }

  logQueryError(error, `${ROUTE} (getReceiptByToken)`, { token_prefix: token.slice(0, 8) })
  if (!saleBase) return null

  return buildReceipt(admin, saleBase, false)
}

/**
 * Impressão interna, autenticada (/vendas/[id]/comprovante). SEMPRE escopada
 * por companyId — resolvido pelo chamador a partir da sessão
 * (requirePageRole → profile.company_id), nunca de um parâmetro de URL.
 * Inclui dados de cliente (nome, sem CPF) — só nesta variante.
 */
export async function getReceiptForSalePrint(params: {
  saleId: number
  companyId: number
}): Promise<ReceiptData | null> {
  const admin = createAdminClient()
  const { data: saleBase, error } = await admin
    .from('sales')
    .select(SALE_BASE_COLUMNS)
    .eq('id', params.saleId)
    .eq('company_id', params.companyId)
    .maybeSingle() as unknown as { data: any; error: PgErrorLike | null }

  logQueryError(error, `${ROUTE} (getReceiptForSalePrint)`, { sale_id: params.saleId, company_id: params.companyId })
  if (!saleBase) return null

  return buildReceipt(admin, saleBase, true)
}
