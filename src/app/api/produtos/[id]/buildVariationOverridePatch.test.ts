import { describe, it, expect } from 'vitest'
import { buildVariationOverridePatch } from './buildVariationOverridePatch'
import { resolveSalePrice } from '@/lib/pricing/resolveSalePrice'

describe('buildVariationOverridePatch', () => {
  it('campo não enviado (undefined) — nunca entra no patch, preserva valor atual no banco', () => {
    expect(buildVariationOverridePatch({})).toEqual({})
    expect(buildVariationOverridePatch({ price_override: 45 })).toEqual({ price_override: 45 })
  })

  it('editar override de atacado existente — grava o novo valor', () => {
    expect(buildVariationOverridePatch({ wholesale_price_override: 30 })).toEqual({ wholesale_price_override: 30 })
  })

  it('limpar override (null explícito) — volta a herdar do produto-pai', () => {
    expect(buildVariationOverridePatch({ wholesale_price_override: null })).toEqual({ wholesale_price_override: null })
  })

  it('varejo e atacado editados juntos, independentemente', () => {
    expect(buildVariationOverridePatch({ price_override: 60, wholesale_price_override: null }))
      .toEqual({ price_override: 60, wholesale_price_override: null })
  })

  // Mesmo campo (`wholesale_price_override`) usado pelo CSV
  // (import-parser.ts) e pelo PDV/site (resolveSalePrice.ts) — a edição
  // manual grava exatamente na mesma coluna, então o resultado do patch é
  // diretamente consumível por resolveSalePrice sem nenhuma tradução.
  it('campo do patch é o mesmo lido por resolveSalePrice (mesma fonte de verdade do CSV)', () => {
    const patch = buildVariationOverridePatch({ wholesale_price_override: 30 })
    const resolved = resolveSalePrice({
      saleType: 'wholesale',
      basePrice: 50,
      wholesalePrice: 35,
      wholesalePriceOverride: patch.wholesale_price_override,
    })
    expect(resolved).toEqual({ price: 30, missingWholesalePrice: false })
  })

  it('override limpo (null) → resolveSalePrice herda o preço de atacado do produto', () => {
    const patch = buildVariationOverridePatch({ wholesale_price_override: null })
    const resolved = resolveSalePrice({
      saleType: 'wholesale',
      basePrice: 50,
      wholesalePrice: 35,
      wholesalePriceOverride: patch.wholesale_price_override,
    })
    expect(resolved).toEqual({ price: 35, missingWholesalePrice: false })
  })
})
