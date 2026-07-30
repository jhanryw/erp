import { describe, it, expect } from 'vitest'
import { parseImportRows, type ImportRow, type DbData } from './import-parser'

const baseDbData: DbData = {
  categories: [{ id: 1, name: 'Calcinha' }],
  suppliers: [],
  colors: [
    { id: 10, value: 'Dourado', slug: 'dourado' },
    { id: 11, value: 'Prateado', slug: 'prateado' },
  ],
  sizes: [
    { id: 20, value: 'P', slug: 'p' },
    { id: 21, value: 'M', slug: 'm' },
  ],
  existingProducts: [],
  productTypes: [
    { id: 2, slug: 'calcinha', name: 'Calcinha', sku_code: '02' },
  ],
  modeloGovernanceByTipoSlug: {},
  modeloExplicitlyNotUsedTipoSlugs: new Set(),
}

function row(over: Partial<ImportRow>): ImportRow {
  return {
    nome_produto: 'Produto',
    tipo: 'calcinha',
    modelo: 'fio_dental',
    ano: '2026',
    categoria: 'Calcinha',
    cor: 'Dourado',
    tamanho: 'P',
    preco: 50,
    custo: 20,
    estoque_inicial: 0,
    ativo: 'true',
    ...over,
  }
}

describe('parseImportRows — detecção de conflito de SKU-pai no CSV', () => {
  it('detecta dois produtos com nomes diferentes mas mesmo Tipo+Modelo+Ano (mesmo SKU-pai)', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado' }),
      row({ nome_produto: 'Calcinha Fio Prateado', cor: 'Prateado' }),
    ]

    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(true)
    const conflict = issues.find(i => i.message.includes('Conflito de SKU'))
    expect(conflict).toBeDefined()
    expect(conflict!.type).toBe('error')
    expect(conflict!.message).toContain('Calcinha Fio Dourado')
    expect(conflict!.message).toContain('Calcinha Fio Prateado')
    expect(conflict!.message).toContain('Tipo: calcinha')
    expect(conflict!.message).toContain('Modelo: fio_dental')
    expect(conflict!.message).toContain('Ano: 2026')
    expect(conflict!.message).toContain('Cor: Dourado')
    expect(conflict!.message).toContain('Cor: Prateado')
    expect(conflict!.message).toMatch(/linha 2/)
    expect(conflict!.message).toMatch(/linha 3/)
  })

  it('NÃO reporta conflito para variantes (cor/tamanho) do MESMO produto', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'P' }),
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'M' }),
    ]

    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(issues.some(i => i.message.includes('Conflito de SKU'))).toBe(false)
    expect(hasErrors).toBe(false)
  })

  it('não conflita produtos com Modelo diferente (SKU-pai diferente)', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', modelo: 'fio_dental' }),
      row({ nome_produto: 'Calcinha Renda Preta', modelo: 'renda' }),
    ]

    const { issues } = parseImportRows(rows, baseDbData)

    expect(issues.some(i => i.message.includes('Conflito de SKU'))).toBe(false)
  })
})
