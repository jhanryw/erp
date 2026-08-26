import { describe, it, expect } from 'vitest'
import { buildProductSearchItem, type ProductSearchRow } from './buildProductSearchItem'

function row(over: Partial<ProductSearchRow>): ProductSearchRow {
  return {
    variation_id: 1,
    sku_variation: 'SKU-1',
    product_name: 'Produto Teste',
    base_price: 69.90,
    price_override: null,
    wholesale_price: null,
    wholesale_price_override: null,
    cost: 30,
    cor: 'Preto',
    tamanho: 'P',
    stock: 10,
    ...over,
  }
}

describe('buildProductSearchItem — PDV varejo/atacado', () => {
  it('retail usa base_price quando a variação não tem price_override', () => {
    const item = buildProductSearchItem(row({ base_price: 69.90 }), 'retail')
    expect(item.price).toBe(69.90)
    expect(item.missing_wholesale_price).toBe(false)
  })

  it('retail usa price_override da variação quando presente', () => {
    const item = buildProductSearchItem(row({ base_price: 69.90, price_override: 59.90 }), 'retail')
    expect(item.price).toBe(59.90)
  })

  it('wholesale usa wholesale_price do produto quando a variação não tem override', () => {
    const item = buildProductSearchItem(row({ wholesale_price: 49.90 }), 'wholesale')
    expect(item.price).toBe(49.90)
    expect(item.missing_wholesale_price).toBe(false)
  })

  it('wholesale usa wholesale_price_override da variação quando presente', () => {
    const item = buildProductSearchItem(row({ wholesale_price: 49.90, wholesale_price_override: 45.90 }), 'wholesale')
    expect(item.price).toBe(45.90)
  })

  it('wholesale sem preço de atacado cadastrado (produto E variação) NUNCA cai pro preço de varejo', () => {
    const item = buildProductSearchItem(row({ base_price: 69.90, price_override: 59.90 }), 'wholesale')
    expect(item.price).toBeNull()
    expect(item.missing_wholesale_price).toBe(true)
  })

  it('demais campos (sku/nome/custo/cor/tamanho/estoque) são preservados independente da modalidade', () => {
    const item = buildProductSearchItem(row({}), 'wholesale')
    expect(item.variation_id).toBe(1)
    expect(item.sku).toBe('SKU-1')
    expect(item.product_name).toBe('Produto Teste')
    expect(item.cost).toBe(30)
    expect(item.cor).toBe('Preto')
    expect(item.tamanho).toBe('P')
    expect(item.stock).toBe(10)
  })
})
