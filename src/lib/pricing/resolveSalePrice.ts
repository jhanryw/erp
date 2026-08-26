/**
 * Resolução de preço efetivo de um item por modalidade de venda (retail/
 * wholesale) — fundação varejo/atacado, 2026-08-31.
 *
 * Espelha EXATAMENTE a mesma granularidade e semântica de fallback já
 * usada hoje para o preço de varejo em produção (confirmado por auditoria:
 * `COALESCE(pv.price_override, p.base_price)`, usado em
 * `src/app/api/produtos/buscar/route.ts:125` e em várias views/RPCs —
 * ex. `supabase/migrations/20260612_fix_vw_stock_live_balances.sql:31`):
 *   retail    → variação.price_override           ?? produto.base_price
 *   wholesale → variação.wholesale_price_override  ?? produto.wholesale_price
 *
 * Política de segurança para "produto sem preço de atacado" (decisão de
 * negócio explícita): uma venda wholesale NUNCA cai silenciosamente no
 * preço de varejo. Se nem a variação nem o produto têm preço de atacado
 * cadastrado, `price` volta `null` e `missingWholesalePrice: true` —
 * quem chama decide o que fazer (bloquear item, pedir preço manual, etc.).
 * Nenhuma constraint de banco força isso (produtos legados continuam
 * válidos sem preço de atacado) — a garantia é só nesta camada.
 *
 * Módulo PURO: sem I/O, sem chamada a banco — recebe os valores já
 * carregados. Não tem consumidor em rota/RPC ainda nesta fase (PDV e
 * `/api/produtos/buscar` continuam resolvendo só varejo, como hoje) —
 * existe para o PDV/API futuros reutilizarem sem reimplementar a regra.
 */

export type SaleType = 'retail' | 'wholesale'

export interface ResolveSalePriceInput {
  saleType: SaleType
  /** products.base_price — preço de varejo do produto-pai. */
  basePrice: number
  /** product_variations.price_override — preço de varejo específico da variação, se houver. */
  priceOverride?: number | null
  /** products.wholesale_price — preço de atacado do produto-pai, se houver. */
  wholesalePrice?: number | null
  /** product_variations.wholesale_price_override — preço de atacado específico da variação, se houver. */
  wholesalePriceOverride?: number | null
}

export interface ResolveSalePriceResult {
  /** Preço resolvido, ou `null` quando wholesale foi pedido mas não há preço de atacado cadastrado (ver `missingWholesalePrice`). */
  price: number | null
  /** `true` somente quando `saleType==='wholesale'` e nem a variação nem o produto têm preço de atacado — nunca cai no preço de varejo silenciosamente. */
  missingWholesalePrice: boolean
}

export function resolveSalePrice(input: ResolveSalePriceInput): ResolveSalePriceResult {
  if (input.saleType === 'retail') {
    return {
      price: input.priceOverride ?? input.basePrice,
      missingWholesalePrice: false,
    }
  }

  const wholesale = input.wholesalePriceOverride ?? input.wholesalePrice ?? null
  if (wholesale == null) {
    return { price: null, missingWholesalePrice: true }
  }

  return { price: wholesale, missingWholesalePrice: false }
}
