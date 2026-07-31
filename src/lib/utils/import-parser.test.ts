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

describe('parseImportRows — múltiplos produtos com o mesmo sku_base (ledger product_sku_identities)', () => {
  it('aceita produtos diferentes com o mesmo Tipo+Modelo+Ano sem reportar conflito de SKU', () => {
    // Desde o ledger product_sku_identities, vários produtos comerciais
    // podem legitimamente compartilhar o mesmo sku_base — cada um recebe
    // um discriminator diferente, resolvido pela RPC. A prévia não deve
    // mais bloquear isso.
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado' }),
      row({ nome_produto: 'Calcinha Fio Prateado', cor: 'Prateado' }),
    ]

    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(issues.some(i => i.message.includes('Conflito de SKU'))).toBe(false)
    expect(hasErrors).toBe(false)
    expect(parsedProducts).toHaveLength(2)
    expect(parsedProducts.map(p => p.name).sort()).toEqual(['Calcinha Fio Dourado', 'Calcinha Fio Prateado'])
    expect(parsedProducts.every(p => p.tipo === 'calcinha' && p.modelo === 'fio_dental' && p.ano === '2026')).toBe(true)
  })

  it('aceita 3+ produtos diferentes compartilhando o mesmo Tipo+Modelo+Ano (base histórica com vários produtos)', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio A', cor: 'Dourado' }),
      row({ nome_produto: 'Calcinha Fio B', cor: 'Prateado' }),
      row({ nome_produto: 'Calcinha Fio C', cor: 'Dourado', tamanho: 'M' }),
    ]

    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(issues.some(i => i.message.includes('Conflito de SKU'))).toBe(false)
    expect(hasErrors).toBe(false)
    expect(parsedProducts).toHaveLength(3)
  })

  it('continua agrupando variantes (cor/tamanho) do MESMO produto numa única entrada', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'P' }),
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'M' }),
    ]

    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues).toHaveLength(0)
    expect(parsedProducts).toHaveLength(1)
    expect(parsedProducts[0].variants).toHaveLength(2)
  })

  it('continua rejeitando cor+tamanho duplicados dentro do MESMO produto', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'P' }),
      row({ nome_produto: 'Calcinha Fio Dourado', cor: 'Dourado', tamanho: 'P' }),
    ]

    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(true)
    expect(issues.some(i => i.message.includes('cor+tamanho duplicados'))).toBe(true)
  })

  it('produtos com Modelo diferente continuam sendo tratados como produtos distintos', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Fio Dourado', modelo: 'fio_dental' }),
      row({ nome_produto: 'Calcinha Renda Preta', modelo: 'renda', cor: 'Prateado' }),
    ]

    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(issues.some(i => i.message.includes('Conflito de SKU'))).toBe(false)
    expect(hasErrors).toBe(false)
    expect(parsedProducts).toHaveLength(2)
    expect(parsedProducts.find(p => p.name === 'Calcinha Fio Dourado')?.modelo).toBe('fio_dental')
    expect(parsedProducts.find(p => p.name === 'Calcinha Renda Preta')?.modelo).toBe('renda')
  })
})
