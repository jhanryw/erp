// Mapeamento puro de uma linha bruta de product_variations/products para o
// item devolvido por GET /api/produtos/buscar — separado da rota (que faz
// I/O) pra ser testável sem banco, mesmo padrão já usado no projeto para
// lógica de preço/negócio (src/lib/sales/pricing.ts,
// src/lib/pricing/resolveSalePrice.ts).
//
// PDV atacado/varejo (2026-09-02) — resolução de preço centralizada aqui,
// via resolveSalePrice (fundação da Fase 1). Nenhum componente de frontend
// deve recalcular preço — todos consomem o `price` já resolvido por esta
// função.

import { resolveSalePrice, type SaleType } from '@/lib/pricing/resolveSalePrice'

export interface ProductSearchRow {
  variation_id: number
  sku_variation: string
  product_name: string
  base_price: number
  price_override: number | null
  wholesale_price: number | null
  wholesale_price_override: number | null
  cost: number
  cor: string | null
  tamanho: string | null
  stock: number
}

export interface ProductSearchItem {
  variation_id: number
  sku: string
  product_name: string
  /** `null` quando saleType='wholesale' e o produto não tem preço de atacado cadastrado — ver `missing_wholesale_price`. NUNCA cai silenciosamente no preço de varejo. */
  price: number | null
  /** `true` quando o item não pode ser vendido em atacado por falta de preço cadastrado — UI deve bloquear/avisar, nunca ignorar. */
  missing_wholesale_price: boolean
  cost: number
  cor: string | null
  tamanho: string | null
  stock: number
}

export function buildProductSearchItem(row: ProductSearchRow, saleType: SaleType): ProductSearchItem {
  const resolved = resolveSalePrice({
    saleType,
    basePrice: row.base_price,
    priceOverride: row.price_override,
    wholesalePrice: row.wholesale_price,
    wholesalePriceOverride: row.wholesale_price_override,
  })

  return {
    variation_id: row.variation_id,
    sku: row.sku_variation,
    product_name: row.product_name,
    price: resolved.price,
    missing_wholesale_price: resolved.missingWholesalePrice,
    cost: row.cost,
    cor: row.cor,
    tamanho: row.tamanho,
    stock: row.stock,
  }
}
