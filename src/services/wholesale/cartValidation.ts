/**
 * Revalidação de carrinho do catálogo de atacado — SEM login, SEM criação
 * de venda. Único propósito: antes de abrir o WhatsApp, confirmar que
 * preço e estoque que o navegador guardou em localStorage ainda batem com
 * o banco real (seção 11/20 do pedido — nunca confia só no valor
 * client-side).
 *
 * Usa a MESMA regra de vendabilidade do catálogo (`./sellability`) —
 * nunca uma segunda lógica de preço/estoque/disponibilidade. Nunca baixa/
 * reserva estoque (só leitura) — reserva de estoque ao adicionar ao
 * carrinho está EXPLICITAMENTE fora de escopo (seção 20 do pedido).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { getWholesaleSiteSettings } from './settings'
import { selectAllInChunks } from './queryBatching'
import { evaluateWholesaleSellability, loadWholesaleStockByVariation } from './sellability'
import { loadAttributesByVariation, type VariationAttribute } from './attributes'

export interface CartValidationItemInput {
  variationId: number
  quantity: number
}

export type CartValidationFailureReason = 'not_found' | 'inactive' | 'not_enabled' | 'no_wholesale_price' | 'insufficient_stock'

export type CartValidationItemResult =
  | { variationId: number; ok: true; price: number; availableQuantity: number }
  | { variationId: number; ok: false; reason: CartValidationFailureReason; price: number | null; availableQuantity: number }

/**
 * Totais calculados NO SERVIDOR (nunca confiar no total do navegador).
 * `subtotal` soma, por item, preço ATUAL × quantidade que o carrinho terá
 * depois do ajuste: itens ok pela quantidade pedida; itens com estoque
 * insuficiente (mas > 0) pela quantidade disponível; itens removidos não contam.
 */
export interface CartValidationSummary {
  subtotal: number
  minimumOrderAmount: number
  meetsMinimum: boolean
  missingForMinimum: number
}

export interface CartValidationResult {
  valid: boolean
  items: CartValidationItemResult[]
  summary: CartValidationSummary
}

interface CartVariationRow {
  id: number
  sku_variation: string
  active: boolean
  wholesale_price_override: number | null
  products: { id: number; name: string; company_id: number; active: boolean; wholesale_enabled: boolean; wholesale_price: number | null } | null
}

/** Linha do carrinho já reconstruída a partir do BANCO (nada vem do navegador) — base do snapshot do pedido. */
export interface ResolvedCartLine {
  variationId: number
  productId: number
  productName: string
  sku: string
  attributes: VariationAttribute[]
  quantity: number
  unitPrice: number
}

export async function revalidateWholesaleCart(
  companyId: number,
  items: CartValidationItemInput[],
): Promise<CartValidationResult> {
  return (await resolveWholesaleCart(companyId, items, { snapshot: false })).validation
}

/**
 * Valida o carrinho e, com `snapshot: true`, reconstrói as linhas (produto,
 * SKU, atributos, preço) a partir do banco — usado na criação do pedido.
 * Só entram em `lines` os itens OK (quando o carrinho é válido, todos).
 */
export async function resolveWholesaleCart(
  companyId: number,
  items: CartValidationItemInput[],
  options: { snapshot: boolean },
): Promise<{ validation: CartValidationResult; lines: ResolvedCartLine[] }> {
  const variationIds = items.map((i) => i.variationId)
  // Carrinho vazio: nada a validar (a rota nem aceita — min(1)); resumo neutro.
  if (variationIds.length === 0) return { validation: { valid: true, items: [], summary: { subtotal: 0, minimumOrderAmount: 0, meetsMinimum: true, missingForMinimum: 0 } }, lines: [] }

  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)

  const variationRows = await selectAllInChunks<CartVariationRow, number>(variationIds, (chunk, from, to) =>
    (admin as any)
      .from('product_variations')
      .select('id, sku_variation, active, wholesale_price_override, products!inner(id, name, company_id, active, wholesale_enabled, wholesale_price)')
      .in('id', chunk)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const stockByVariation = await loadWholesaleStockByVariation(admin, companyId, variationIds)
  const variationsById = new Map(variationRows.map((v) => [v.id, v]))

  const results: CartValidationItemResult[] = items.map((item) => {
    const v = variationsById.get(item.variationId)
    const availableQuantity = stockByVariation[item.variationId] ?? 0

    // Multi-tenant: variação de outra empresa é tratada como inexistente.
    if (!v || !v.products || v.products.company_id !== companyId) {
      return { variationId: item.variationId, ok: false, reason: 'not_found', price: null, availableQuantity: 0 }
    }

    const verdict = evaluateWholesaleSellability({ product: v.products, variation: v, stock: availableQuantity })

    if (!verdict.sellable) {
      switch (verdict.reason) {
        // Só expõe estoque de item que É vendável no catálogo (ou que só
        // falta estoque) — nunca de produto fora do atacado/inativo/sem preço
        // (evita enumerar estoque de ids arbitrários).
        case 'product_inactive':
        case 'variation_inactive':
          return { variationId: item.variationId, ok: false, reason: 'inactive', price: null, availableQuantity: 0 }
        case 'not_enabled':
          return { variationId: item.variationId, ok: false, reason: 'not_enabled', price: null, availableQuantity: 0 }
        case 'no_wholesale_price':
          return { variationId: item.variationId, ok: false, reason: 'no_wholesale_price', price: null, availableQuantity: 0 }
        case 'out_of_stock':
          return { variationId: item.variationId, ok: false, reason: 'insufficient_stock', price: verdict.price, availableQuantity }
      }
    }

    if (availableQuantity < item.quantity) {
      return { variationId: item.variationId, ok: false, reason: 'insufficient_stock', price: verdict.price, availableQuantity }
    }

    return { variationId: item.variationId, ok: true, price: verdict.price, availableQuantity }
  })

  // Total em centavos inteiros (sem erro de ponto flutuante).
  let subtotalCents = 0
  results.forEach((r, i) => {
    if (r.price == null) return
    const quantity = r.ok ? items[i].quantity : Math.min(items[i].quantity, r.availableQuantity)
    if (quantity > 0) subtotalCents += Math.round(r.price * 100) * quantity
  })
  const subtotal = subtotalCents / 100
  const minimumOrderAmount = settings.minimumOrderAmount
  const missingForMinimum = Math.max(0, Math.round((minimumOrderAmount - subtotal) * 100) / 100)

  const validation: CartValidationResult = {
    valid: results.every((r) => r.ok),
    items: results,
    summary: { subtotal, minimumOrderAmount, meetsMinimum: missingForMinimum === 0, missingForMinimum },
  }

  const lines: ResolvedCartLine[] = []
  if (options.snapshot) {
    const okIds = results.filter((r) => r.ok).map((r) => r.variationId)
    const attributes = await loadAttributesByVariation(admin as any, okIds)
    results.forEach((r, i) => {
      const v = variationsById.get(r.variationId)
      if (!r.ok || !v?.products) return
      lines.push({
        variationId: r.variationId,
        productId: v.products.id,
        productName: v.products.name,
        sku: v.sku_variation,
        attributes: attributes[r.variationId] ?? [],
        quantity: items[i].quantity,
        unitPrice: r.price,
      })
    })
  }

  return { validation, lines }
}
