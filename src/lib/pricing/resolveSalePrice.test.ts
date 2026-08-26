import { describe, it, expect } from 'vitest'
import { resolveSalePrice } from './resolveSalePrice'

describe('resolveSalePrice', () => {
  it('retail: usa price_override quando presente', () => {
    const result = resolveSalePrice({ saleType: 'retail', basePrice: 100, priceOverride: 80 })
    expect(result).toEqual({ price: 80, missingWholesalePrice: false })
  })

  it('retail: cai para base_price quando não há override — comportamento intacto', () => {
    const result = resolveSalePrice({ saleType: 'retail', basePrice: 100, priceOverride: null })
    expect(result).toEqual({ price: 100, missingWholesalePrice: false })
  })

  it('wholesale: usa wholesale_price_override quando presente', () => {
    const result = resolveSalePrice({
      saleType: 'wholesale', basePrice: 100, wholesalePrice: 70, wholesalePriceOverride: 60,
    })
    expect(result).toEqual({ price: 60, missingWholesalePrice: false })
  })

  it('wholesale: cai para wholesale_price do produto quando a variação não tem override', () => {
    const result = resolveSalePrice({ saleType: 'wholesale', basePrice: 100, wholesalePrice: 70 })
    expect(result).toEqual({ price: 70, missingWholesalePrice: false })
  })

  it('wholesale: produto sem preço de atacado — price null, missingWholesalePrice true, NUNCA cai pro preço de varejo', () => {
    const result = resolveSalePrice({ saleType: 'wholesale', basePrice: 100, priceOverride: 80 })
    expect(result.price).toBeNull()
    expect(result.missingWholesalePrice).toBe(true)
  })

  it('wholesale: variação sem override mas produto também sem wholesale_price — ainda missing', () => {
    const result = resolveSalePrice({
      saleType: 'wholesale', basePrice: 100, wholesalePrice: null, wholesalePriceOverride: null,
    })
    expect(result).toEqual({ price: null, missingWholesalePrice: true })
  })
})
