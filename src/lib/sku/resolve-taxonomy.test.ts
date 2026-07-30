import { describe, it, expect } from 'vitest'
import {
  resolveTipoModelo, matchProductType, matchModeloValue,
  type ProductTypeCandidate, type ModeloGovernance,
} from './resolve-taxonomy'

// Fixture representando o estado real do PIM: praticamente todo Tipo legado
// já existe em product_types (202607301700_pim_seed_legacy_product_types.sql),
// mas só Cinta/Meia-calça/Acessório Íntimo/Sex Shop têm governança ATIVA de
// Modelo (type_attributes). Sutiã e Pijama existem em product_types mas
// permanecem legados (sem type_attributes) — exatamente o caso que expôs o
// bug: "Tipo existe em product_types" não pode ser o critério de dynamic.
const productTypes: ProductTypeCandidate[] = [
  { id: 1,  slug: 'sutia',           name: 'Sutiã',              sku_code: '01' },
  { id: 2,  slug: 'calcinha',        name: 'Calcinha',           sku_code: '02' },
  { id: 4,  slug: 'pijama',          name: 'Pijama',             sku_code: '04' },
  { id: 15, slug: 'cinta',           name: 'Cinta',              sku_code: '15' },
  { id: 16, slug: 'sex_shop',        name: 'Sex Shop',           sku_code: '16' },
  { id: 17, slug: 'meia_calca',      name: 'Meia-calça',         sku_code: '17' },
  { id: 18, slug: 'acessorio_intimo',name: 'Acessório Íntimo',   sku_code: '18' },
  // Tipo fictício pra exercitar o caso 3 (sem governança, sem mapa legado):
  { id: 99, slug: 'moda_praia',      name: 'Moda Praia',         sku_code: '50' },
]

const governance: Record<string, ModeloGovernance> = {
  cinta: {
    required: true,
    values: [
      { id: 101, value: 'Liga',              slug: 'liga',              sku_code: '15' },
      { id: 102, value: 'Modeladora',        slug: 'modeladora',        sku_code: '16' },
      { id: 103, value: 'Body Modelador',    slug: 'body-modelador',    sku_code: '17' },
      { id: 104, value: 'Regata Modeladora', slug: 'regata-modeladora', sku_code: '18' },
      { id: 105, value: 'Short',             slug: 'short',             sku_code: '19' },
    ],
  },
  meia_calca: {
    required: true,
    values: [
      { id: 201, value: 'Lisa',    slug: 'lisa',    sku_code: '20' },
      { id: 202, value: 'Térmica', slug: 'termica', sku_code: '22' },
    ],
  },
  acessorio_intimo: {
    required: true,
    values: [
      { id: 301, value: 'Fita para Seios',    slug: 'fita-para-seios',    sku_code: '26' },
      { id: 302, value: 'Protetor de Mamilo', slug: 'protetor-de-mamilo', sku_code: '27' },
    ],
  },
  sex_shop: {
    required: false,
    values: [
      { id: 401, value: 'Vibrador', slug: 'vibrador', sku_code: '29' },
      { id: 402, value: 'Sugador',  slug: 'sugador',  sku_code: '28' },
    ],
  },
  // 'sutia' e 'pijama' de propósito não têm entrada aqui — existem em
  // product_types mas nunca ganharam type_attributes pra Modelo.
}

// Helper: sku_scheme é derivado por quem chama (import/route.ts) via
// `resolved.productTypeId ? 'dynamic' : 'legacy'` — replicado aqui só pra
// deixar a asserção de cada teste explícita sobre esse critério.
function impliedSkuScheme(result: { productTypeId?: number }): 'dynamic' | 'legacy' {
  return result.productTypeId ? 'dynamic' : 'legacy'
}

describe('resolveTipoModelo — Tipos governados dinamicamente (sku_scheme=dynamic)', () => {
  it('Cinta governada dinamicamente com Modelo Short', () => {
    const r = resolveTipoModelo('Cinta', 'Short', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('dynamic')
    expect(r.result).toEqual({
      tipo: 'cinta', modelo: 'Short', modeloValueId: 105,
      productTypeId: 15, tipoSkuCode: '15', modeloSkuCode: '19',
    })
  })

  it('Meia-calça governada dinamicamente', () => {
    const r = resolveTipoModelo('Meia-calça', 'Lisa', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('dynamic')
    expect(r.result.productTypeId).toBe(17)
    expect(r.result.modeloValueId).toBe(201)
  })

  it('rejeita CSV com Tipo Cinta e Modelo inválido, listando os modelos válidos', () => {
    const r = resolveTipoModelo('Cinta', 'Inexistente', productTypes, governance)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Modelo 'Inexistente' não está vinculado ao Tipo 'Cinta'")
    expect(r.error).toContain('Liga')
    expect(r.error).toContain('Short')
  })

  it('rejeita Modelo pertencente a outro Tipo (Vibrador é de Sex Shop, não de Cinta)', () => {
    const r = resolveTipoModelo('Cinta', 'Vibrador', productTypes, governance)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Modelo 'Vibrador' não está vinculado ao Tipo 'Cinta'")
  })

  it('Sex Shop aceita Modelo ausente (required=false)', () => {
    const r = resolveTipoModelo('Sex Shop', '', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('dynamic')
    expect(r.result.modelo).toBe('sem_modelo')
    expect(r.result.modeloValueId).toBeUndefined()
  })

  it('Cinta rejeita Modelo ausente (required=true)', () => {
    const r = resolveTipoModelo('Cinta', '', productTypes, governance)
    expect(r.ok).toBe(false)
  })
})

describe('resolveTipoModelo — Tipos existentes em product_types mas ainda legados (sku_scheme=legacy)', () => {
  it('Sutiã existe em product_types mas usa o fluxo legado (sem governança ativa)', () => {
    const r = resolveTipoModelo('Sutiã', 'Básico com Bojo', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('legacy')
    expect(r.result.productTypeId).toBeUndefined()
    expect(r.result.tipoSkuCode).toBeUndefined()
    expect(r.result).toEqual({ tipo: 'sutia', modelo: 'basico_com_bojo' })
  })

  it('Pijama existe em product_types mas usa o fluxo legado (sem governança ativa)', () => {
    const r = resolveTipoModelo('Pijama', 'Vestido', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('legacy')
    expect(r.result.productTypeId).toBeUndefined()
    expect(r.result).toEqual({ tipo: 'pijama', modelo: 'vestido' })
  })

  it('Pijama rejeita Modelo inexistente no mapa legado', () => {
    const r = resolveTipoModelo('Pijama', 'Modelo Que Não Existe', productTypes, governance)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Modelo 'Modelo Que Não Existe' não está vinculado ao Tipo 'Pijama'")
  })

  it('Tipo ausente de product_types (empresa nova, sem backfill) também cai no fallback legado', () => {
    const semProductTypes: ProductTypeCandidate[] = []
    const r = resolveTipoModelo('sutia', 'renda', semProductTypes, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('legacy')
    expect(r.result.tipo).toBe('sutia')
  })
})

describe('resolveTipoModelo — Tipo sem governança dinâmica e sem mapa legado', () => {
  it('rejeita com erro de configuração quando não há nenhum sinal (nem governança, nem legado, nem declaração explícita)', () => {
    const r = resolveTipoModelo('Moda Praia', 'Qualquer Coisa', productTypes, governance)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Tipo 'Moda Praia' existe no PIM mas não tem nenhuma configuração de Modelo")
  })

  it('aceita Modelo livre/ausente quando o domínio declara explicitamente que o Tipo não usa Modelo codificado', () => {
    const explicitlyNotUsed = new Set(['moda_praia'])
    const r = resolveTipoModelo('Moda Praia', '', productTypes, governance, explicitlyNotUsed)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(impliedSkuScheme(r.result)).toBe('dynamic')
    expect(r.result.productTypeId).toBe(99)
    expect(r.result.tipoSkuCode).toBe('50')
    expect(r.result.modelo).toBe('sem_modelo')
  })

  it('Tipo inexistente em qualquer lugar (PIM ou mapa legado) é rejeitado listando os Tipos válidos', () => {
    const r = resolveTipoModelo('Tipo Fantasioso', 'Modelo X', productTypes, governance)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Tipo de produto 'Tipo Fantasioso' não encontrado ou inativo no PIM")
    expect(r.error).toContain('Cinta')
  })
})

describe('resolveTipoModelo — normalização (acentos, espaços, hífen, underscore)', () => {
  it('matchProductType resolve "Meia-calça", "Meia Calça" e "meia_calca" pro mesmo Tipo', () => {
    const variants = ['Meia-calça', 'Meia Calça', 'meia_calca', 'MEIA CALCA', ' meia-calca ']
    for (const v of variants) {
      expect(matchProductType(v, productTypes)?.slug).toBe('meia_calca')
    }
  })

  it('matchProductType resolve "Acessório Íntimo" e "acessorio_intimo" pro mesmo Tipo', () => {
    expect(matchProductType('Acessório Íntimo', productTypes)?.slug).toBe('acessorio_intimo')
    expect(matchProductType('acessorio_intimo', productTypes)?.slug).toBe('acessorio_intimo')
    expect(matchProductType('acessorio-intimo', productTypes)?.slug).toBe('acessorio_intimo')
  })

  it('matchModeloValue resolve "Body Modelador", "body-modelador" e "BODY_MODELADOR" pro mesmo valor', () => {
    const candidates = governance.cinta.values
    for (const v of ['Body Modelador', 'body-modelador', 'BODY_MODELADOR', 'body modelador']) {
      expect(matchModeloValue(v, candidates)?.id).toBe(103)
    }
  })

  it('resolveTipoModelo aceita variações de grafia de Tipo e Modelo simultaneamente', () => {
    const r = resolveTipoModelo('CINTA', 'short', productTypes, governance)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.modeloValueId).toBe(105)
  })
})

describe('resolveTipoModelo — determinismo (pré-validação === importação definitiva)', () => {
  it('retorna exatamente o mesmo resultado em chamadas repetidas com os mesmos dados (função pura)', () => {
    const inputs: [string, string][] = [
      ['Cinta', 'Short'],
      ['Meia-calça', 'Térmica'],
      ['Sex Shop', ''],
      ['Pijama', 'Longo'],
      ['Sutiã', 'Renda'],
      ['Cinta', 'Modelo Inválido'],
      ['Moda Praia', 'X'],
    ]
    for (const [tipo, modelo] of inputs) {
      const first  = resolveTipoModelo(tipo, modelo, productTypes, governance)
      const second = resolveTipoModelo(tipo, modelo, productTypes, governance)
      expect(second).toEqual(first)
    }
  })
})
