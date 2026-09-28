import { describe, it, expect } from 'vitest'
import { buildVariationOverrideUpdates, describeOverrideError, type OverrideEdit } from './variationOverrides'

const v = (id: number, price: number | string | null, wholesale: number | string | null = null) =>
  ({ id, sku_variation: `SKU-${id}`, price_override: price, wholesale_price_override: wholesale })
const e = (price: string, wholesale = ''): OverrideEdit => ({ price_override: price, wholesale_price_override: wholesale })

describe('buildVariationOverrideUpdates', () => {
  it('override null → 12,90', () => {
    const r = buildVariationOverrideUpdates([v(1, null)], { 1: e('12,90') })
    expect(r).toEqual({ updates: [{ id: 1, price_override: 12.9, wholesale_price_override: null }], errors: [] })
  })

  it('override 10 → 12.90', () => {
    const r = buildVariationOverrideUpdates([v(1, 10)], { 1: e('12.90') })
    expect(r.updates).toEqual([{ id: 1, price_override: 12.9, wholesale_price_override: null }])
  })

  it('limpar override existente → null', () => {
    const r = buildVariationOverrideUpdates([v(1, 10, 8)], { 1: e('', '8') })
    expect(r.updates).toEqual([{ id: 1, price_override: null, wholesale_price_override: 8 }])
  })

  it('nenhum campo alterado → nada no payload (inclusive formato diferente do mesmo valor)', () => {
    const r = buildVariationOverrideUpdates(
      [v(1, null), v(2, 12.9), v(3, '12.90', 5)],
      { 1: e(''), 2: e('12,90'), 3: e('12.9', '5,00') },
    )
    expect(r).toEqual({ updates: [], errors: [] })
  })

  it('valor inválido nunca entra no payload e vira erro', () => {
    const r = buildVariationOverrideUpdates(
      [v(1, null), v(2, null), v(3, null)],
      { 1: e('abc'), 2: e('0,00'), 3: e('15', 'xyz') },
    )
    expect(r.updates).toEqual([])
    expect(r.errors.map((x) => [x.variationId, x.field])).toEqual([
      [1, 'price_override'], [2, 'price_override'], [3, 'wholesale_price_override'],
    ])
    expect(describeOverrideError(r.errors[0])).toMatch(/^SKU-1 · Preço varejo específico: Valor inválido/)
  })

  it('nenhum NaN chega ao JSON', () => {
    const r = buildVariationOverrideUpdates(
      [v(1, null), v(2, 10), v(3, null)],
      { 1: e('12,90', '9,5'), 2: e('abc'), 3: e(' 1.234,56 ') },
    )
    const json = JSON.stringify({ variations_to_update: r.updates })
    expect(json).not.toMatch(/NaN|Infinity/)
    expect(JSON.parse(json).variations_to_update).toEqual([
      { id: 1, price_override: 12.9, wholesale_price_override: 9.5 },
      { id: 3, price_override: 1234.56, wholesale_price_override: null },
    ])
  })

  it('variação sem edição carregada é ignorada', () => {
    expect(buildVariationOverrideUpdates([v(1, 10)], {})).toEqual({ updates: [], errors: [] })
  })
})
