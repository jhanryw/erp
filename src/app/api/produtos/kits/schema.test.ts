import { describe, it, expect } from 'vitest'
import { createKitSchema, setKitComponentsSchema, zodErrorMessage } from './schema'

const base = {
  name: 'Kit 3 Calcinhas',
  sku: 'KIT-3',
  category_id: 1,
  base_price: 49.9,
  variations: [
    { sku_variation: 'KIT-PB-M', components: [
      { component_product_variation_id: 10, quantity: 1 },
      { component_product_variation_id: 11, quantity: 2 },
    ] },
  ],
}

describe('createKitSchema', () => {
  it('aceita kit válido com SKU próprio e preço próprio', () => {
    const parsed = createKitSchema.parse(base)
    expect(parsed.variations[0].sku_variation).toBe('KIT-PB-M')
    expect(parsed.active).toBe(true)
  })

  it('não aceita company_id do cliente (campo descartado)', () => {
    const parsed = createKitSchema.parse({ ...base, company_id: 999 }) as Record<string, unknown>
    expect(parsed.company_id).toBeUndefined()
  })

  it('bloqueia kit sem componentes', () => {
    const res = createKitSchema.safeParse({ ...base, variations: [{ sku_variation: 'X-1', components: [] }] })
    expect(res.success).toBe(false)
    if (!res.success) expect(zodErrorMessage(res.error)).toMatch(/pelo menos um componente/)
  })

  it('bloqueia kit sem variação', () => {
    expect(createKitSchema.safeParse({ ...base, variations: [] }).success).toBe(false)
  })

  it('bloqueia quantidade zero, negativa ou fracionária', () => {
    for (const quantity of [0, -1, 1.5]) {
      const res = createKitSchema.safeParse({ ...base, variations: [{ sku_variation: 'X-1', components: [{ component_product_variation_id: 1, quantity }] }] })
      expect(res.success).toBe(false)
    }
  })

  it('bloqueia SKUs de variação repetidos (case-insensitive)', () => {
    const res = createKitSchema.safeParse({ ...base, variations: [
      { sku_variation: 'kit-1', components: [{ component_product_variation_id: 1, quantity: 1 }] },
      { sku_variation: 'KIT-1', components: [{ component_product_variation_id: 2, quantity: 1 }] },
    ] })
    expect(res.success).toBe(false)
  })

  it('preserva SKU com zeros à esquerda como texto', () => {
    const parsed = createKitSchema.parse({ ...base, variations: [{ sku_variation: '007-KIT', components: [{ component_product_variation_id: 1, quantity: 1 }] }] })
    expect(parsed.variations[0].sku_variation).toBe('007-KIT')
  })

  it('bloqueia preço zero', () => {
    expect(createKitSchema.safeParse({ ...base, base_price: 0 }).success).toBe(false)
  })
})

describe('setKitComponentsSchema', () => {
  it('exige ao menos um componente', () => {
    expect(setKitComponentsSchema.safeParse({ components: [] }).success).toBe(false)
  })

  it('aceita duplicados (consolidados depois, de forma determinística)', () => {
    expect(setKitComponentsSchema.safeParse({ components: [
      { component_product_variation_id: 1, quantity: 1 },
      { component_product_variation_id: 1, quantity: 2 },
    ] }).success).toBe(true)
  })
})
