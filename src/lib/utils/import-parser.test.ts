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

describe('parseImportRows — fundação varejo/atacado (preco_atacado/ncm/origem_fiscal/cst)', () => {
  it('CSV sem os campos novos continua funcionando exatamente como antes (retrocompatibilidade)', () => {
    const rows: ImportRow[] = [row({ nome_produto: 'Calcinha Sem Atacado' })]
    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues).toHaveLength(0)
    expect(parsedProducts[0].wholesale_price).toBeUndefined()
    expect(parsedProducts[0].ncm).toBeUndefined()
    expect(parsedProducts[0].origem_fiscal).toBeUndefined()
    expect(parsedProducts[0].cst).toBeUndefined()
  })

  it('lê preco_atacado/ncm/origem_fiscal/cst quando presentes no CSV', () => {
    const rows: ImportRow[] = [row({
      nome_produto: 'Calcinha Com Atacado',
      preco_atacado: 35, ncm: '61091000', origem_fiscal: 0, cst: '060',
    })]
    const { issues, hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues).toHaveLength(0)
    expect(parsedProducts[0].wholesale_price).toBe(35)
    expect(parsedProducts[0].ncm).toBe('61091000')
    expect(parsedProducts[0].origem_fiscal).toBe(0)
    expect(parsedProducts[0].cst).toBe('060')
  })

  it('rejeita preco_atacado <= 0', () => {
    const rows: ImportRow[] = [row({ nome_produto: 'Calcinha Atacado Inválido', preco_atacado: -5 })]
    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(true)
    expect(issues.some(i => i.message.includes('Preço de atacado inválido'))).toBe(true)
  })

  it('rejeita origem_fiscal fora do intervalo 0-8', () => {
    const rows: ImportRow[] = [row({ nome_produto: 'Calcinha Origem Inválida', origem_fiscal: 9 })]
    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(true)
    expect(issues.some(i => i.message.includes('Origem fiscal inválida'))).toBe(true)
  })

  it('rejeita NCM que não tem exatamente 8 dígitos', () => {
    const rows: ImportRow[] = [row({ nome_produto: 'Calcinha NCM Inválido', ncm: '123' })]
    const { issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(true)
    expect(issues.some(i => i.message.includes('NCM inválido'))).toBe(true)
  })

  it('linha com sku preenchido vira ATUALIZAÇÃO, não criação — mesmo com colunas de criação também preenchidas', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', preco: 47.9, nome_produto: 'Ignorado', tipo: 'inexistente' }]
    const { parsedProducts, parsedUpdates, issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues).toHaveLength(0)
    expect(parsedProducts).toHaveLength(0) // nunca cria produto — tipo 'inexistente' seria erro se fosse tratado como criação
    expect(parsedUpdates).toHaveLength(1)
    expect(parsedUpdates[0]).toEqual({ client_index: 0, sku: 'ABC123', price_override: 47.9 })
  })

  it('atualização: só inclui as chaves de campos EFETIVAMENTE preenchidos (célula vazia nunca vira chave presente)', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', preco_atacado: 42.9 }]
    const { parsedUpdates } = parseImportRows(rows, baseDbData)

    expect(parsedUpdates).toHaveLength(1)
    const update = parsedUpdates[0]
    expect(update.wholesale_price_override).toBe(42.9)
    expect('price_override' in update).toBe(false)
    expect('ncm' in update).toBe(false)
    expect('origem' in update).toBe(false)
    expect('cst' in update).toBe(false)
  })

  it('atualização: NCM com pontuação é rejeitado na prévia (esperado só dígitos) e não entra no patch — mas não bloqueia o envio (warning, não error)', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', ncm: '6108.22.00' }]
    const { parsedUpdates, issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues.some(i => i.type === 'warning' && i.message.includes('NCM inválido'))).toBe(true)
    expect('ncm' in parsedUpdates[0]).toBe(false)
  })

  it('atualização: NCM só de dígitos é aceito', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', ncm: '61082200' }]
    const { parsedUpdates, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(parsedUpdates[0].ncm).toBe('61082200')
  })

  it('atualização: origem fiscal fora de 0-8 gera warning e não entra no patch', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', origem_fiscal: 9 }]
    const { parsedUpdates, issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues.some(i => i.type === 'warning' && i.message.includes('origem fiscal inválida'))).toBe(true)
    expect('origem' in parsedUpdates[0]).toBe(false)
  })

  it('atualização: preço negativo/zero gera warning e não entra no patch (nunca manda NaN/valor ruim ao servidor)', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', preco: -10 }]
    const { parsedUpdates, issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues.some(i => i.type === 'warning' && i.message.includes('preço de varejo inválido'))).toBe(true)
    expect('price_override' in parsedUpdates[0]).toBe(false)
  })

  it('atualização: CST é passado como texto livre, sem validação de formato', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', cst: '060' }]
    const { parsedUpdates } = parseImportRows(rows, baseDbData)

    expect(parsedUpdates[0].cst).toBe('060')
  })

  it('atualização: SKU duplicado dentro do próprio CSV gera warning (não bloqueia) — servidor decide o resultado final', () => {
    const rows: ImportRow[] = [
      { sku: 'ABC123', preco: 10 },
      { sku: 'ABC123', preco: 20 },
    ]
    const { parsedUpdates, issues, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(issues.some(i => i.type === 'warning' && i.message.includes('duplicado'))).toBe(true)
    expect(parsedUpdates).toHaveLength(2) // ambas enviadas — servidor reporta a ambígua/duplicada como erro
  })

  it('múltiplas linhas de atualização para produtos diferentes geram client_index sequenciais e independentes', () => {
    const rows: ImportRow[] = [
      { sku: 'AAA', preco: 10 },
      { sku: 'BBB', preco: 20 },
      { sku: 'CCC', preco: 30 },
    ]
    const { parsedUpdates } = parseImportRows(rows, baseDbData)

    expect(parsedUpdates.map(u => u.client_index)).toEqual([0, 1, 2])
    expect(parsedUpdates.map(u => u.sku)).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('atualização: aceita o mesmo formato monetário que o importador já suporta hoje (separador decimal ".", ex.: 47.90) — não introduz um segundo parser concorrente', () => {
    const rows: ImportRow[] = [{ sku: 'ABC123', preco: '47.90', preco_atacado: '42.90' }]
    const { parsedUpdates, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(parsedUpdates[0].price_override).toBe(47.9)
    expect(parsedUpdates[0].wholesale_price_override).toBe(42.9)
  })

  it('CSV sem coluna sku continua 100% no fluxo de criação (retrocompatibilidade total)', () => {
    const rows: ImportRow[] = [row({ nome_produto: 'Produto Antigo' })]
    const { parsedProducts, parsedUpdates, hasErrors } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    expect(parsedUpdates).toHaveLength(0)
    expect(parsedProducts).toHaveLength(1)
  })

  it('gera wholesale_price_override por variante só quando o preço de atacado da linha diverge do produto-pai', () => {
    const rows: ImportRow[] = [
      row({ nome_produto: 'Calcinha Multi Atacado', cor: 'Dourado', tamanho: 'P', preco_atacado: 35 }),
      row({ nome_produto: 'Calcinha Multi Atacado', cor: 'Prateado', tamanho: 'M', preco_atacado: 30 }),
    ]
    const { hasErrors, parsedProducts } = parseImportRows(rows, baseDbData)

    expect(hasErrors).toBe(false)
    const product = parsedProducts[0]
    expect(product.wholesale_price).toBe(35) // primeira linha define o produto-pai
    expect(product.variants.find(v => v.color_value_id === 10)?.wholesale_price_override).toBeUndefined() // igual ao pai
    expect(product.variants.find(v => v.color_value_id === 11)?.wholesale_price_override).toBe(30) // diverge → override
  })
})
