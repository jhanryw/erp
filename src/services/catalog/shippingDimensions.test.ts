import { describe, it, expect } from 'vitest'
import { resolveProductShippingDimensions } from './shippingDimensions'

const product = { weight_kg: 0.25, package_length_cm: 20, package_width_cm: 15, package_height_cm: 5 }

describe('resolveProductShippingDimensions', () => {
  it('peso e dimensões no nível do produto; variação sem override herda', () => {
    const r = resolveProductShippingDimensions(product, { weight_kg_override: null })
    expect(r).toMatchObject({ weightKg: 0.25, lengthCm: 20, widthCm: 15, heightCm: 5, dimensionsComplete: true, dimensionsPartial: false, issues: [] })
    expect(r.source).toEqual({ weightKg: 'product', lengthCm: 'product', widthCm: 'product', heightCm: 'product' })
  })

  it('variação sobrescreve peso (dimensões continuam do produto)', () => {
    const r = resolveProductShippingDimensions(product, { weight_kg_override: '0.4' })
    expect(r.weightKg).toBe(0.4)
    expect(r.source.weightKg).toBe('variation')
    expect(r.source.lengthCm).toBe('product')
  })

  it('variação sobrescreve dimensões campo a campo', () => {
    const r = resolveProductShippingDimensions(product, { package_length_cm_override: 30, package_height_cm_override: 8 })
    expect(r).toMatchObject({ lengthCm: 30, widthCm: 15, heightCm: 8 })
    expect(r.source).toMatchObject({ lengthCm: 'variation', widthCm: 'product', heightCm: 'variation' })
  })

  it('peso ausente → null (nunca 0) e origem none', () => {
    const r = resolveProductShippingDimensions({}, null)
    expect(r).toMatchObject({ weightKg: null, lengthCm: null, widthCm: null, heightCm: null, dimensionsComplete: false, dimensionsPartial: false })
    expect(r.source.weightKg).toBe('none')
    expect(resolveProductShippingDimensions(null, undefined).weightKg).toBeNull()
  })

  it('peso zero ou negativo é inválido (issue; valor efetivo null) — inclusive override', () => {
    const zero = resolveProductShippingDimensions({ weight_kg: 0 }, null)
    expect(zero.weightKg).toBeNull()
    expect(zero.issues).toEqual([{ field: 'weightKg', source: 'product', reason: 'non_positive' }])
    const neg = resolveProductShippingDimensions(product, { weight_kg_override: -1 })
    expect(neg.weightKg).toBeNull()
    expect(neg.issues).toEqual([{ field: 'weightKg', source: 'variation', reason: 'non_positive' }])
    expect(resolveProductShippingDimensions({ weight_kg: 'abc' }, null).issues[0].reason).toBe('not_a_number')
  })

  it('dimensão parcial (só largura) → dimensionsPartial', () => {
    const r = resolveProductShippingDimensions({ weight_kg: 1, package_width_cm: 10 }, null)
    expect(r).toMatchObject({ widthCm: 10, lengthCm: null, heightCm: null, dimensionsPartial: true, dimensionsComplete: false })
  })

  it('string vazia no override = herda do produto', () => {
    expect(resolveProductShippingDimensions(product, { weight_kg_override: '  ' }).source.weightKg).toBe('product')
  })
})
