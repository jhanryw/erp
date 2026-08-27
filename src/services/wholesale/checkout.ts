/**
 * Checkout do site de atacado — Fase 8, seção 23 do pedido.
 *
 * Reaproveita `createSale()` (mesma infraestrutura de criação de venda do
 * PDV/troca) — nunca duplica `rpc_create_sale`. Único ponto que fixa
 * `sale_type='wholesale'`/`sales_channel='wholesale_site'` no SERVIDOR —
 * o payload do browser nunca é capaz de escolher esses dois valores (ver
 * `WholesaleCheckoutInput`: nem existe campo pra isso).
 *
 * Segurança de preço/estoque (seções 24-25 do pedido): preço e custo são
 * SEMPRE recarregados do banco aqui — o browser manda só `variationId` +
 * `quantity`. Qualquer `unit_price` que o cliente tentasse mandar é
 * ignorado por construção (o tipo de entrada nem tem esse campo).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { createSale, type DeliveryRecipientInput } from '@/services/vendas.service'
import { resolveSalePrice } from '@/lib/pricing/resolveSalePrice'
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey } from './checkoutIdempotency'
import { logError } from '@/lib/errors/log'
import { resolveFiscalOperation } from '@/services/fiscal/resolveFiscalOperation'
import { executeFiscalPolicy } from '@/services/fiscal/executeFiscalPolicy'

export interface WholesaleCartItemInput {
  variationId: number
  quantity: number
}

export interface WholesaleCheckoutInput {
  customerId: number
  companyId: number
  systemUserId: string
  idempotencyKey: string
  items: WholesaleCartItemInput[]
  deliveryMode: 'pickup' | 'delivery'
  deliveryRecipient?: DeliveryRecipientInput | null
  notes?: string | null
}

export interface UnavailableItem {
  variationId: number
  reason: 'not_found' | 'inactive' | 'no_wholesale_price' | 'insufficient_stock'
  requested: number
  available: number | null
}

export type WholesaleCheckoutOutcome =
  | { ok: true; saleId: number; saleNumber: string; total: number }
  | { ok: false; status: number; error: string; unavailableItems?: UnavailableItem[] }

function failure(status: number, error: string, unavailableItems?: UnavailableItem[]): WholesaleCheckoutOutcome {
  return { ok: false, status, error, unavailableItems }
}

export async function checkoutWholesaleCart(input: WholesaleCheckoutInput): Promise<WholesaleCheckoutOutcome> {
  if (input.items.length === 0) {
    return failure(422, 'Carrinho vazio.')
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return failure(422, `Quantidade inválida para o item (variação #${item.variationId}).`)
    }
  }

  const claim = await claimIdempotencyKey(input.idempotencyKey, input.companyId, input.customerId)
  if (claim.decision === 'already_completed') {
    // Replay seguro de duplo clique/duplo submit — devolve o MESMO
    // resultado, nunca cria uma segunda venda (seção 39 do pedido).
    const admin = createAdminClient()
    const { data: sale } = await (admin as any)
      .from('sales')
      .select('id, sale_number, total')
      .eq('id', claim.saleId)
      .maybeSingle() as { data: { id: number; sale_number: string; total: number } | null }
    if (sale) return { ok: true, saleId: sale.id, saleNumber: sale.sale_number, total: Number(sale.total) }
    return failure(500, 'Pedido processado anteriormente, mas não foi possível recuperar os detalhes. Consulte "Meus pedidos".')
  }
  if (claim.decision === 'already_processing') {
    return failure(409, 'Este pedido já está sendo processado. Aguarde alguns segundos e verifique "Meus pedidos" antes de tentar de novo.')
  }
  if (claim.decision === 'already_failed') {
    return failure(422, claim.errorMessage ?? 'Falha na tentativa anterior — tente novamente.')
  }

  try {
    const admin = createAdminClient()
    const variationIds = input.items.map((i) => i.variationId)

    // ── Carrega variações + produto (empresa/ativo, preço vem do BANCO) ──
    const { data: variationRows } = await (admin as any)
      .from('product_variations')
      .select('id, active, sku_variation, price_override, wholesale_price_override, cost_override, product_id, products!inner(id, company_id, active, wholesale_price, base_cost)')
      .in('id', variationIds) as { data: any[] | null }

    const variationsById = new Map((variationRows ?? []).map((v) => [v.id, v]))

    // ── Estoque real (mesmo escopo que online_priority vai debitar) ─────
    const { data: stockRows } = await (admin as any)
      .from('stock_balances')
      .select('product_variation_id, quantity, stock_locations!inner(company_id, active)')
      .in('product_variation_id', variationIds)
      .eq('stock_locations.company_id', input.companyId)
      .eq('stock_locations.active', true) as { data: { product_variation_id: number; quantity: number }[] | null }

    const stockByVariation: Record<number, number> = {}
    for (const row of stockRows ?? []) {
      stockByVariation[row.product_variation_id] = (stockByVariation[row.product_variation_id] ?? 0) + Number(row.quantity ?? 0)
    }

    const unavailable: UnavailableItem[] = []
    const saleItems: { product_variation_id: number; quantity: number; unit_price: number; unit_cost: number; discount_amount: number; surcharge_amount: number }[] = []

    for (const item of input.items) {
      const v = variationsById.get(item.variationId)
      if (!v) {
        unavailable.push({ variationId: item.variationId, reason: 'not_found', requested: item.quantity, available: null })
        continue
      }
      const product = v.products
      // Multi-tenant: variação precisa pertencer a um produto DESTA
      // empresa — nunca confia em variationId isolado (seção 8/35 do pedido).
      if (product.company_id !== input.companyId) {
        unavailable.push({ variationId: item.variationId, reason: 'not_found', requested: item.quantity, available: null })
        continue
      }
      if (!v.active || !product.active) {
        unavailable.push({ variationId: item.variationId, reason: 'inactive', requested: item.quantity, available: null })
        continue
      }

      const resolved = resolveSalePrice({
        saleType: 'wholesale',
        basePrice: 0,
        priceOverride: null,
        wholesalePrice: product.wholesale_price,
        wholesalePriceOverride: v.wholesale_price_override,
      })
      if (resolved.price == null) {
        unavailable.push({ variationId: item.variationId, reason: 'no_wholesale_price', requested: item.quantity, available: null })
        continue
      }

      const availableStock = stockByVariation[item.variationId] ?? 0
      if (availableStock < item.quantity) {
        unavailable.push({ variationId: item.variationId, reason: 'insufficient_stock', requested: item.quantity, available: availableStock })
        continue
      }

      const unitCost = v.cost_override ?? product.base_cost ?? 0

      saleItems.push({
        product_variation_id: item.variationId,
        quantity: item.quantity,
        unit_price: resolved.price,
        unit_cost: unitCost,
        discount_amount: 0,
        surcharge_amount: 0,
      })
    }

    if (unavailable.length > 0) {
      const message = 'Alguns itens não possuem mais a quantidade solicitada ou deixaram de estar disponíveis.'
      await failIdempotencyKey(input.idempotencyKey, message)
      return failure(409, message, unavailable)
    }

    const total = Math.round(saleItems.reduce((s, i) => s + i.unit_price * i.quantity, 0) * 100) / 100

    // ── Pagamento (seção 21/27 do pedido) ────────────────────────────────
    // Sem gateway real integrado neste ERP (auditado — nenhuma integração
    // Pix/cartão em nenhum ponto do projeto) — 'invoice' representa
    // cobrança NEGOCIADA/faturada fora do sistema, nunca um "Pix"/"Cartão"
    // fingindo ter processado algo que não aconteceu. Fiscal pode ser
    // emitido depois normalmente (mesmo modelo "emitir depois" da Fase
    // Fiscal 6) — só fica pendente até o pagamento real ser conciliado.
    const result = await createSale({
      customer_id: input.customerId,
      payment_method: 'invoice' as any,
      payments: [{ method: 'invoice' as any, amount_tendered: total, net_amount: total, change_amount: 0 }],
      // sale_origin='website' — mesma semântica já usada pela Nuvemshop
      // pra "não presencial", preserva o comportamento existente de
      // resolveFiscalDocumentType (website força NF-e) sem inventar um
      // valor novo (seção 32 do pedido).
      sale_origin: 'website',
      discount_amount: 0,
      surcharge_amount: 0,
      cashback_used: 0,
      cashback_action: 'accumulate',
      shipping_charged: 0,
      notes: input.notes ?? null,
      items: saleItems,
      systemUserId: input.systemUserId,
      cashSessionId: null,
      responsible_seller_id: null,
      sale_type: 'wholesale',
      sales_channel: 'wholesale_site',
      stockMode: 'online_priority',
      deliveryRecipient: input.deliveryMode === 'delivery' ? (input.deliveryRecipient ?? null) : null,
    })

    if (!result.ok) {
      await failIdempotencyKey(input.idempotencyKey, result.error)
      return failure(result.status, result.error)
    }

    // Shipment — mesmo padrão do PDV/API de vendas (não-atômico, erro é
    // não-fatal): registrado separadamente logo depois da venda.
    await (admin as any).from('shipments').insert({
      order_id: result.data.id,
      customer_id: input.customerId,
      delivery_mode: input.deliveryMode,
      status: input.deliveryMode === 'pickup' ? 'aguardando_retirada' : 'aguardando_confirmacao',
      notes: input.notes ?? null,
      company_id: input.companyId,
    })

    await completeIdempotencyKey(input.idempotencyKey, result.data.id)

    // Motor Fiscal Configurável — sale_origin='website' (linha acima) tem
    // PRIORIDADE sobre sale_type='wholesale' na resolução de operation_type
    // (decisão confirmada em chat na revisão de consolidação 7→4 tipos):
    // venda do site de atacado obedece à política 'website' (NF-e
    // AUTOMÁTICA), não 'wholesale' (NF-e manual) — mesmo tratamento de
    // qualquer outro pedido do site. Ver resolveOperationType.ts pro
    // raciocínio completo dessa troca de comportamento deliberada. Antes
    // desta fase, checkout de atacado NUNCA emitia nada fiscal (gap real,
    // confirmado por auditoria) — nunca pode fazer o checkout falhar, a
    // venda já foi criada com sucesso.
    try {
      const fiscalDecision = await resolveFiscalOperation({
        companyId: input.companyId,
        saleType: 'wholesale',
        saleOrigin: 'website',
        deliveryMode: input.deliveryMode,
        operatorChoice: 'auto',
      })
      await executeFiscalPolicy({ saleId: result.data.id, companyId: input.companyId, decision: fiscalDecision })
    } catch (fiscalErr) {
      logError({ route: 'checkoutWholesaleCart (fiscal emission)', err: fiscalErr, context: { sale_id: result.data.id } })
    }

    return { ok: true, saleId: result.data.id, saleNumber: result.data.sale_number, total }
  } catch (err) {
    // Fase 8, seção 33 do pedido — API pública nunca repassa mensagem
    // técnica crua (poderia vazar detalhe interno de query/schema).
    // `wholesale_checkout_idempotency` é service_role-only (RLS deny-by-
    // default) — pode guardar o detalhe técnico completo pra depuração de
    // staff sem risco de exposição; a resposta HTTP fica só com a versão
    // genérica.
    const technicalMessage = err instanceof Error ? err.message : 'Erro desconhecido'
    logError({ route: 'checkoutWholesaleCart', err, context: { companyId: input.companyId, customerId: input.customerId } })
    await failIdempotencyKey(input.idempotencyKey, technicalMessage)
    return failure(500, 'Não foi possível concluir o pedido. Tente novamente em instantes.')
  }
}
