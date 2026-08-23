/**
 * Fórmulas de precificação de venda — Fase Fiscal 5C.
 *
 * Espelha EXATAMENTE a aritmética do `rpc_create_sale` vigente
 * (`supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql`)
 * — fonte única de verdade usada tanto no front-end (totais exibidos antes
 * de enviar a venda) quanto nos testes que documentam as invariantes desta
 * fase. Nunca duplicar esta conta inline em outro lugar — se a fórmula do
 * RPC mudar, este módulo (e os testes que o cobrem) precisam mudar junto.
 *
 * Invariantes garantidas por este módulo (ver testes):
 *   - `total_price` do item = (unit_price × quantity) − discount + surcharge.
 *   - `subtotal` do pedido = soma dos `total_price` dos itens.
 *   - `products_total` (valor de mercadoria, SEM frete) = subtotal −
 *     discount_amount de PEDIDO (nunca soma shipping_charged).
 *   - `total` financeiro = products_total + surcharge_amount de pedido +
 *     shipping_charged − cashback_used (nunca negativo).
 */

export interface PricingItem {
  unitPrice: number
  quantity: number
  discountAmount: number
  surchargeAmount: number
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** total_price de um item — nunca lê list_price_snapshot (informativo, fora do cálculo). */
export function computeItemTotal(item: PricingItem): number {
  return round2(item.unitPrice * item.quantity - item.discountAmount + item.surchargeAmount)
}

/** subtotal do pedido = soma dos total_price dos itens (já líquido de ajustes por item). */
export function computeSubtotal(items: PricingItem[]): number {
  return round2(items.reduce((sum, item) => sum + computeItemTotal(item), 0))
}

/**
 * products_total — valor comercial líquido das MERCADORIAS. NUNCA inclui
 * `shipping_charged` — essa é a distinção central desta fase (frete não é
 * automaticamente valor fiscal).
 *
 * Fórmula definitiva (revisão pós-Blocker 2, ver
 * docs/fiscal-fase5c-blockers-revisao.md):
 *
 *   products_total = subtotal − sales.discount_amount + sales.surcharge_amount
 *
 * onde `subtotal` já é a soma de `total_price` de cada item (§computeSubtotal
 * acima) — ou seja, já contém 100% dos ajustes conhecidos POR ITEM (preço
 * negociado embutido em unit_price, mais discount_amount/surcharge_amount
 * explícitos do item, se usados). `sales.discount_amount`/
 * `sales.surcharge_amount` são os ajustes GLOBAIS de pedido — campos
 * independentes dos itens (nunca derivados somando-os), então somá-los aqui
 * nunca duplica um ajuste já contado no subtotal: são fontes ortogonais por
 * construção (ver invariante de não-duplicidade nos testes).
 *
 * Correção em relação à primeira versão desta fase: a fórmula original só
 * subtraía `discount_amount` e deliberadamente omitia `surcharge_amount`
 * (por cautela, sem dado real para confirmar). Auditoria confirmou que
 * omitir o acréscimo global é inconsistente — ele é, pela mesma definição
 * de "ajuste global de mercadoria" que o desconto global, e o exemplo de
 * negócio (produtos 80 + acréscimo 8 = products_total 88) só bate com o
 * acréscimo incluído.
 */
export function computeProductsTotal(subtotal: number, orderDiscountAmount: number, orderSurchargeAmount: number): number {
  return round2(subtotal - orderDiscountAmount + orderSurchargeAmount)
}

export interface GrandTotalInput {
  subtotal: number
  discountAmount: number
  surchargeAmount: number
  shippingCharged: number
  cashbackUsed: number
}

/** Total financeiro da venda — inclui frete, nunca fica negativo. */
export function computeGrandTotal(input: GrandTotalInput): number {
  const gross = Math.max(0, round2(input.subtotal - input.discountAmount + input.surchargeAmount + input.shippingCharged))
  return round2(Math.max(0, gross - input.cashbackUsed))
}

export interface ItemAdjustmentFromListPrice {
  desconto: number
  acrescimo: number
}

/**
 * Deriva desconto/acréscimo IMPLÍCITOS de um item a partir da diferença
 * entre o preço de tabela (snapshot) e o preço efetivamente vendido —
 * usado só para EXIBIÇÃO na UI (single source of truth = unit_price
 * digitado pelo vendedor; desconto/acréscimo aqui são sempre DERIVADOS,
 * nunca a fonte). `listPrice: null` (sem preço de tabela capturado) →
 * nenhum ajuste implícito exibido.
 */
export function computeItemAdjustmentFromListPrice(unitPrice: number, listPrice: number | null): ItemAdjustmentFromListPrice {
  if (listPrice == null) return { desconto: 0, acrescimo: 0 }
  const diff = round2(listPrice - unitPrice)
  if (diff > 0) return { desconto: diff, acrescimo: 0 }
  if (diff < 0) return { desconto: 0, acrescimo: round2(-diff) }
  return { desconto: 0, acrescimo: 0 }
}
