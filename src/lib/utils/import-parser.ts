import { generateSKU, generateParentSKU } from './../sku/sku-map'

export type ImportRow = {
  nome_produto?: string
  nome?: string
  tipo?: string
  modelo?: string
  ano?: string | number
  categoria?: string
  fornecedor?: string
  origem?: string
  cor?: string
  tamanho?: string
  preco?: number | string
  custo?: number | string
  estoque_inicial?: number | string
  ativo?: string | boolean
}

export type ParsedProduct = {
  name: string
  tipo: string
  modelo: string
  ano: string
  category_id: number
  supplier_id?: number
  origin: string
  base_cost: number
  base_price: number
  active: boolean
  variants: {
    sku_variation: string
    color_value_id?: number
    size_value_id?: number
    price_override?: number
    cost_override?: number
    initial_stock: number
  }[]
}

export type ErrorWarning = {
  row: number
  message: string
  type: 'error' | 'warning'
}

export type DbData = {
  categories: { id: number; name: string }[]
  suppliers: { id: number; name: string }[]
  colors: { id: number; value: string; slug: string }[]
  sizes: { id: number; value: string; slug: string }[]
}

export function parseImportRows(rawRows: ImportRow[], dbData: DbData) {
  const newIssues: ErrorWarning[] = []
  const productMap = new Map<string, ParsedProduct>()

  rawRows.forEach((row, index) => {
    const rowNum = index + 2 // considerando cabeçalho na linha 1

    const nome_produto = String(row.nome_produto || row.nome || '')
    const tipo = String(row.tipo || '')
    const modelo = String(row.modelo || '')
    const ano = String(row.ano || new Date().getFullYear().toString())
    const categoriaStr = String(row.categoria || '')
    const fornecedorStr = String(row.fornecedor || '')
    const origemStr = String(row.origem || 'terceiro')
    const corStr = String(row.cor || '')
    const tamanhoStr = String(row.tamanho || '')
    const pPreco = Number(row.preco)
    const pCusto = Number(row.custo)
    const estoque = Number(row.estoque_inicial || 0)
    const ativo = String(row.ativo).toLowerCase() === 'false' ? false : true

    if (!nome_produto) newIssues.push({ row: rowNum, message: 'Nome do produto vazio', type: 'error' })
    if (!tipo || !modelo) newIssues.push({ row: rowNum, message: 'Tipo e Modelo são obrigatórios', type: 'error' })
    if (isNaN(pPreco) || pPreco <= 0) newIssues.push({ row: rowNum, message: 'Preço inválido ou vazio', type: 'error' })
    if (isNaN(pCusto) || pCusto < 0) newIssues.push({ row: rowNum, message: 'Custo inválido', type: 'error' })
    if (isNaN(estoque) || estoque < 0) newIssues.push({ row: rowNum, message: 'Estoque não pode ser negativo', type: 'error' })
    
    if (pPreco < pCusto) newIssues.push({ row: rowNum, message: 'Preço abaixo do custo (margem negativa)', type: 'warning' })

    const cat = dbData.categories.find(c => c.name.toLowerCase() === categoriaStr.trim().toLowerCase())
    let category_id = cat?.id || 0
    if (!cat) newIssues.push({ row: rowNum, message: `Categoria '${categoriaStr}' não encontrada`, type: 'error' })

    let supplier_id: number | undefined = undefined
    if (fornecedorStr) {
      const supp = dbData.suppliers.find(s => s.name.toLowerCase() === fornecedorStr.trim().toLowerCase())
      if (supp) {
        supplier_id = supp.id
      } else {
        newIssues.push({ row: rowNum, message: `Fornecedor '${fornecedorStr}' não encontrado (será ignorado)`, type: 'warning' })
      }
    }

    let color_value_id: number | undefined = undefined
    if (corStr) {
      const cMatch = dbData.colors.find(c => c.value.toLowerCase() === corStr.trim().toLowerCase())
      if (cMatch) color_value_id = cMatch.id
      else newIssues.push({ row: rowNum, message: `Cor '${corStr}' não encontrada no sistema`, type: 'error' })
    }

    let size_value_id: number | undefined = undefined
    if (tamanhoStr) {
      const sMatch = dbData.sizes.find(c => c.value.toLowerCase() === tamanhoStr.trim().toLowerCase())
      if (sMatch) size_value_id = sMatch.id
      else newIssues.push({ row: rowNum, message: `Tamanho '${tamanhoStr}' não encontrado no sistema`, type: 'error' })
    }

    const origin = origemStr.toLowerCase().includes('propria') || origemStr.toLowerCase().includes('própria') ? 'own_brand' : 'third_party'

    let sku_variacao = ''
    try {
      if (tipo && modelo) {
        sku_variacao = generateSKU({ tipo, modelo, cor: corStr, tamanho: tamanhoStr, ano })
      }
    } catch {
      newIssues.push({ row: rowNum, message: `Erro ao gerar SKU (campos inválidos)`, type: 'error' })
    }

    const mapKey = `${tipo}-${modelo}`
    
    if (!productMap.has(mapKey)) {
      productMap.set(mapKey, {
        name: nome_produto,
        tipo,
        modelo,
        ano,
        category_id,
        supplier_id,
        origin,
        base_cost: pCusto,
        base_price: pPreco,
        active: ativo,
        variants: []
      })
    }

    const product = productMap.get(mapKey)!
    
    const exists = product.variants.some(v => v.sku_variation === sku_variacao)
    if (exists) {
      newIssues.push({ row: rowNum, message: `Combinação de Cor/Tamanho gera SKU duplicado '${sku_variacao}'`, type: 'error' })
    } else if (sku_variacao) {
      product.variants.push({
        sku_variation: sku_variacao,
        color_value_id,
        size_value_id,
        cost_override: pCusto !== product.base_cost ? pCusto : undefined,
        price_override: pPreco !== product.base_price ? pPreco : undefined,
        initial_stock: estoque
      })
    }
  })

  return {
    parsedProducts: Array.from(productMap.values()),
    issues: newIssues
  }
}
