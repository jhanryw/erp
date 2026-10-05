import { describe, it, expect } from 'vitest'
import { createProductSkuBuilder } from './product-sku-builder'
import { SKU_TIPO, SKU_MODELO } from './sku-map'

// Admin mínimo: devolve linhas fixas por tabela, ignorando filtros (suficiente
// para o único Tipo/Modelo exercitado aqui).
function admin(opts: { governed?: boolean } = {}) {
  const governed = opts.governed ?? true
  const data: Record<string, any> = {
    product_types: { id: 10, sku_code: '15' },
    variation_types: { id: 100, value_governance: 'type_restricted' },
    type_attributes: governed ? { id: 1 } : null,
    type_attribute_values: [
      { variation_values: { id: 200, value: 'Liga', slug: 'liga', sku_code: '15' } },
      { variation_values: { id: 201, value: 'Short', slug: 'short', sku_code: '19' } },
    ],
  }
  return {
    from(t: string) {
      const q: any = new Proxy({}, { get: (_, p) => p === 'then'
        ? (res: any) => res({ data: data[t], error: null })
        : p === 'maybeSingle' ? () => Promise.resolve({ data: data[t], error: null }) : () => q })
      return q
    },
  }
}

describe('createProductSkuBuilder', () => {
  it('dynamic: Cinta/Short → 15 + 19', async () => {
    const b = await createProductSkuBuilder({ tipo: 'cinta', modelo: 'Short', ano: '2026', sku_scheme: 'dynamic' }, 1, admin())
    expect(b({ corCode: '38', tamanhoCode: '03' })).toBe('1519380326')
    expect(b({})).toBe('1519000026')
  })

  it('dynamic: modelo desconhecido lança com lista de válidos', async () => {
    await expect(createProductSkuBuilder({ tipo: 'cinta', modelo: 'Xyz', ano: '2026', sku_scheme: 'dynamic' }, 1, admin()))
      .rejects.toThrow(/Modelos válidos: Liga, Short/)
  })

  it('dynamic: sem_modelo → MM 00', async () => {
    const b = await createProductSkuBuilder({ tipo: 'cinta', modelo: 'sem_modelo', ano: '2026', sku_scheme: 'dynamic' }, 1, admin())
    expect(b({})).toBe('1500000026')
  })

  it('dynamic: governança removida do Tipo lança erro claro', async () => {
    await expect(createProductSkuBuilder({ tipo: 'cinta', modelo: 'Short', ano: '2026', sku_scheme: 'dynamic' }, 1, admin({ governed: false })))
      .rejects.toThrow(/não tem mais o atributo Modelo ativo/)
  })

  it('legacy (ou sku_scheme ausente): mapa estático, Short é rejeitado em cinta', async () => {
    const ok = await createProductSkuBuilder({ tipo: 'cinta', modelo: 'liga', ano: '2026', sku_scheme: 'legacy' }, 1, admin())
    expect(ok({ corCode: '38', tamanhoCode: '03' })).toBe('1501380326')
    const legacyNull = await createProductSkuBuilder({ tipo: 'cinta', modelo: 'liga', ano: '2026' }, 1, admin())
    expect(legacyNull({})).toBe('1501000026')
    const bad = await createProductSkuBuilder({ tipo: 'cinta', modelo: 'Short', ano: '2026', sku_scheme: 'legacy' }, 1, admin())
    expect(() => bad({})).toThrow(/Modelo 'Short' não encontrado para o tipo 'cinta'/)
  })

  it('invariante: todo tipo do mapa legado tem entrada de modelos', () => {
    for (const code of Object.values(SKU_TIPO)) expect(SKU_MODELO[code]).toBeDefined()
  })
})
