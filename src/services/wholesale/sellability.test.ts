import { describe, it, expect } from 'vitest'
import { evaluateWholesaleSellability, isWholesaleSellable, resolveWholesalePrice } from './sellability'

const OK = {
  product: { active: true, wholesale_enabled: true, wholesale_price: 20 },
  variation: { active: true, wholesale_price_override: null },
  stock: 5,
}

describe('resolveWholesalePrice', () => {
  it('override da variação tem prioridade sobre o preço do produto', () => {
    expect(resolveWholesalePrice(20, 15)).toBe(15)
  })
  it('sem override usa o preço do produto', () => {
    expect(resolveWholesalePrice(20, null)).toBe(20)
    expect(resolveWholesalePrice('20.50', undefined)).toBe(20.5)
  })
  it('sem nenhum preço, zero ou negativo → null (nunca cai no varejo)', () => {
    expect(resolveWholesalePrice(null, null)).toBeNull()
    expect(resolveWholesalePrice(0, null)).toBeNull()
    expect(resolveWholesalePrice(-1, null)).toBeNull()
    expect(resolveWholesalePrice('abc', null)).toBeNull()
  })
  it('override inválido não é mascarado pelo preço do produto', () => {
    expect(resolveWholesalePrice(20, 0)).toBeNull()
  })
})

describe('evaluateWholesaleSellability', () => {
  it('produto ativo + habilitado + variação ativa + preço + estoque → vendável', () => {
    expect(evaluateWholesaleSellability(OK)).toEqual({ sellable: true, price: 20, stock: 5 })
  })
  it('produto inativo → não vendável', () => {
    expect(evaluateWholesaleSellability({ ...OK, product: { ...OK.product, active: false } })).toMatchObject({ sellable: false, reason: 'product_inactive' })
  })
  it('produto não habilitado no atacado → não vendável (mesmo com preço e estoque)', () => {
    expect(evaluateWholesaleSellability({ ...OK, product: { ...OK.product, wholesale_enabled: false } })).toMatchObject({ sellable: false, reason: 'not_enabled' })
  })
  it('variação inativa → não vendável', () => {
    expect(evaluateWholesaleSellability({ ...OK, variation: { ...OK.variation, active: false } })).toMatchObject({ sellable: false, reason: 'variation_inactive' })
  })
  it('habilitado mas sem preço de atacado → não vendável, independente de estar habilitado', () => {
    expect(evaluateWholesaleSellability({ ...OK, product: { ...OK.product, wholesale_price: null } })).toMatchObject({ sellable: false, reason: 'no_wholesale_price', price: null })
  })
  it('estoque zero → não vendável', () => {
    expect(evaluateWholesaleSellability({ ...OK, stock: 0 })).toMatchObject({ sellable: false, reason: 'out_of_stock', price: 20 })
    expect(isWholesaleSellable({ ...OK, stock: 0 })).toBe(false)
  })
})
