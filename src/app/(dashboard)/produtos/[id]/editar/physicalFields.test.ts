import { describe, it, expect } from 'vitest'
import { buildProductPhysicalPatch, buildVariationPhysicalUpdates, parsePhysical, physicalToEdit } from './physicalFields'

describe('physicalFields (tela de edição)', () => {
  it('parse: vírgula decimal no peso; cm inteiros; vazio = null; zero/negativo inválido', () => {
    expect(parsePhysical('weight_kg', '0,35')).toEqual({ ok: true, value: 0.35 })
    expect(parsePhysical('package_width_cm', '')).toEqual({ ok: true, value: null })
    expect(parsePhysical('weight_kg', '0').ok).toBe(false)
    expect(parsePhysical('weight_kg', '-1').ok).toBe(false)
    expect(parsePhysical('package_length_cm', '2.5').ok).toBe(false)
  })

  it('produto: só o que mudou entra no patch; limpar envia null; inválido bloqueia', () => {
    const current = { weight_kg: '0.350', package_length_cm: 25, package_width_cm: null, package_height_cm: null }
    const edit = physicalToEdit(current)
    expect(edit).toEqual({ weight_kg: '0.35', package_length_cm: '25', package_width_cm: '', package_height_cm: '' })
    expect(buildProductPhysicalPatch(edit, current)).toEqual({ patch: {}, errors: [] })
    expect(buildProductPhysicalPatch({ ...edit, package_length_cm: '', package_width_cm: '18' }, current).patch).toEqual({ package_length_cm: null, package_width_cm: 18 })
    expect(buildProductPhysicalPatch({ ...edit, weight_kg: '0' }, current).errors).toHaveLength(1)
  })

  it('variação: override opcional; vazio = herda (null)', () => {
    const vars = [{ id: 1, sku_variation: 'A', weight_kg_override: null }, { id: 2, sku_variation: 'B', weight_kg_override: 0.5 }]
    const r = buildVariationPhysicalUpdates(vars, {
      1: { weight_kg: '0.4', package_length_cm: '', package_width_cm: '', package_height_cm: '' },
      2: { weight_kg: '', package_length_cm: '', package_width_cm: '', package_height_cm: '' },
    })
    expect(r).toEqual({ updates: [{ id: 1, weight_kg_override: 0.4 }, { id: 2, weight_kg_override: null }], errors: [] })
  })
})
