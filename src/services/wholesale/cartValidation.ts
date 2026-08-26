/**
 * Revalidação de carrinho do catálogo de atacado — SEM login, SEM criação
 * de venda. Único propósito: antes de abrir o WhatsApp, confirmar que
 * preço e estoque que o navegador guardou em localStorage ainda batem com
 * o banco real (seção 11/20 do pedido — nunca confia só no valor
 * client-side).
 *
 * Mesma fonte de verdade de preço/estoque que `catalog.ts`/`checkout.ts`
 * (resolveSalePrice + stock_balances das stock_locations ativas da
 * empresa) — nunca uma segunda lógica de disponibilidade. Nunca baixa/
 * reserva estoque (só leitura) — reserva de estoque ao adicionar ao
 * carrinho está EXPLICITAMENTE fora de escopo (seção 20 do pedido).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSalePrice } from '@/lib/pricing/resolveSalePrice'

export interface CartValidationItemInput {
  variationId: number
  quantity: number
}

export type CartValidationItemResult =
  | { variationId: number; ok: true; price: number; availableQuantity: number }
  | { variationId: number; ok: false; reason: 'not_found' | 'inactive' | 'no_wholesale_price' | 'insufficient_stock'; price: number | null; availableQuantity: number }

export interface CartValidationResult {
  valid: boolean
  items: CartValidationItemResult[]
}

export async function revalidateWholesaleCart(
  companyId: number,
  items: CartValidationItemInput[],
): Promise<CartValidationResult> {
  const admin = createAdminClient()
  const variationIds = items.map((i) => i.variationId)

  if (variationIds.length === 0) return { valid: true, items: [] }

  const { data: variationRows } = await (admin as any)
    .from('product_variations')
    .select('id, active, wholesale_price_override, products!inner(id, company_id, active, wholesale_price)')
    .in('id', variationIds) as { data: any[] | null }

  const { data: stockRows } = await (admin as any)
    .from('stock_balances')
    .select('product_variation_id, quantity, stock_locations!inner(company_id, active)')
    .in('product_variation_id', variationIds)
    .eq('stock_locations.company_id', companyId)
    .eq('stock_locations.active', true) as { data: { product_variation_id: number; quantity: number }[] | null }

  const stockByVariation: Record<number, number> = {}
  for (const row of stockRows ?? []) {
    stockByVariation[row.product_variation_id] = (stockByVariation[row.product_variation_id] ?? 0) + Number(row.quantity ?? 0)
  }

  const variationsById = new Map((variationRows ?? []).map((v) => [v.id, v]))

  const results: CartValidationItemResult[] = items.map((item) => {
    const v = variationsById.get(item.variationId)
    const availableQuantity = stockByVariation[item.variationId] ?? 0

    if (!v || v.products?.company_id !== companyId) {
      return { variationId: item.variationId, ok: false, reason: 'not_found', price: null, availableQuantity: 0 }
    }
    if (!v.active || !v.products.active) {
      return { variationId: item.variationId, ok: false, reason: 'inactive', price: null, availableQuantity }
    }

    const resolved = resolveSalePrice({
      saleType: 'wholesale', basePrice: 0, priceOverride: null,
      wholesalePrice: v.products.wholesale_price, wholesalePriceOverride: v.wholesale_price_override,
    })
    if (resolved.price == null) {
      return { variationId: item.variationId, ok: false, reason: 'no_wholesale_price', price: null, availableQuantity }
    }
    if (availableQuantity < item.quantity) {
      return { variationId: item.variationId, ok: false, reason: 'insufficient_stock', price: resolved.price, availableQuantity }
    }

    return { variationId: item.variationId, ok: true, price: resolved.price, availableQuantity }
  })

  return { valid: results.every((r) => r.ok), items: results }
}
