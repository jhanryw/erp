import { resolveTipoModelo, type ProductTypeCandidate, type ModeloGovernance } from '@/lib/sku/resolve-taxonomy'

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
    color_name?: string
    size_value_id?: number
    size_name?: string
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
  existingProducts: { name: string; tipo: string; modelo: string; ano: string }[]
  /** product_types ativos da empresa — resolução de Tipo contra o PIM dinâmico. */
  productTypes: ProductTypeCandidate[]
  /** Governança de Modelo por slug de Tipo (só presente pra Tipos com Modelo
   * governado dinamicamente) — buscada sob demanda em produtos/importar/page.tsx
   * via /api/produtos/modelo-options, uma vez por Tipo distinto no CSV. */
  modeloGovernanceByTipoSlug: Record<string, ModeloGovernance>
  /** Slugs de Tipo com type_attributes existente pra Modelo porém inativo —
   * sinal explícito de "não usa Modelo codificado" (ver resolve-taxonomy.ts). */
  modeloExplicitlyNotUsedTipoSlugs: Set<string>
}

export function parseImportRows(rawRows: ImportRow[], dbData: DbData) {
  const newIssues: ErrorWarning[] = []
  const productMap = new Map<string, ParsedProduct>()

  // Build a set of existing ERP product keys for fast lookup
  const existingKeys = new Set(
    dbData.existingProducts.map(p =>
      `${p.name.toLowerCase().trim()}|${p.tipo}|${p.modelo}|${p.ano}`
    )
  )
  // Track which products in this CSV already triggered the "exists in ERP" error
  const alreadyReportedErpConflict = new Set<string>()

  rawRows.forEach((row, index) => {
    const rowNum = index + 2 // row 1 is the header

    const nome_produto = String(row.nome_produto || row.nome || '')
    const tipo         = String(row.tipo    || '')
    const modelo       = String(row.modelo  || '')
    const ano          = String(row.ano     || new Date().getFullYear().toString())
    const categoriaStr = String(row.categoria  || '')
    const fornecedorStr = String(row.fornecedor || '')
    const origemStr    = String(row.origem  || 'terceiro')
    const corStr       = String(row.cor      || '')
    const tamanhoStr   = String(row.tamanho  || '')
    const pPreco       = Number(row.preco)
    const pCusto       = Number(row.custo)
    const estoque      = Number(row.estoque_inicial || 0)
    const ativo        = String(row.ativo).toLowerCase() === 'false' ? false : true

    // Empty name — can't aggregate anything for this row
    if (!nome_produto.trim()) {
      newIssues.push({ row: rowNum, message: 'Nome do produto vazio', type: 'error' })
      return
    }

    // Resolve Tipo/Modelo contra o PIM dinâmico (mesma função usada pela
    // importação definitiva no servidor — /api/produtos/import) — nunca
    // rejeita um Tipo ativo em product_types só por não estar no mapa
    // estático legado, e resolve o Modelo pelo slug ou texto normalizado
    // dentro da lista governada daquele Tipo.
    const tipoModeloResolution = resolveTipoModelo(
      tipo, modelo, dbData.productTypes, dbData.modeloGovernanceByTipoSlug, dbData.modeloExplicitlyNotUsedTipoSlugs,
    )
    if (!tipoModeloResolution.ok) {
      newIssues.push({ row: rowNum, message: `${nome_produto.trim() || 'Produto'}: ${tipoModeloResolution.error}`, type: 'error' })
      return
    }
    const { tipo: resolvedTipo, modelo: resolvedModelo } = tipoModeloResolution.result

    if (isNaN(pPreco) || pPreco <= 0) newIssues.push({ row: rowNum, message: 'Preço inválido ou vazio', type: 'error' })
    if (isNaN(pCusto) || pCusto < 0)  newIssues.push({ row: rowNum, message: 'Custo inválido', type: 'error' })
    if (isNaN(estoque) || estoque < 0) newIssues.push({ row: rowNum, message: 'Estoque não pode ser negativo', type: 'error' })
    if (pPreco < pCusto) newIssues.push({ row: rowNum, message: 'Preço abaixo do custo (margem negativa)', type: 'warning' })

    const cat = dbData.categories.find(c => c.name.toLowerCase() === categoriaStr.trim().toLowerCase())
    const category_id = cat?.id ?? 0
    if (!cat) newIssues.push({ row: rowNum, message: `Categoria '${categoriaStr}' não encontrada`, type: 'error' })

    let supplier_id: number | undefined
    if (fornecedorStr) {
      const supp = dbData.suppliers.find(s => s.name.toLowerCase() === fornecedorStr.trim().toLowerCase())
      if (supp) {
        supplier_id = supp.id
      } else {
        newIssues.push({ row: rowNum, message: `Fornecedor '${fornecedorStr}' não encontrado`, type: 'error' })
      }
    }

    // Cor e tamanho precisam existir no sistema — criação automática não é permitida
    let color_value_id: number | undefined
    if (corStr) {
      const cMatch = dbData.colors.find(c => c.value.toLowerCase() === corStr.trim().toLowerCase())
      if (cMatch) {
        color_value_id = cMatch.id
      } else {
        newIssues.push({ row: rowNum, message: `Cor '${corStr}' não cadastrada. Cadastre em Variações antes de importar.`, type: 'error' })
      }
    }

    let size_value_id: number | undefined
    if (tamanhoStr) {
      const sMatch = dbData.sizes.find(s => s.value.toLowerCase() === tamanhoStr.trim().toLowerCase())
      if (sMatch) {
        size_value_id = sMatch.id
      } else {
        newIssues.push({ row: rowNum, message: `Tamanho '${tamanhoStr}' não cadastrado. Cadastre em Variações antes de importar.`, type: 'error' })
      }
    }

    const origin = origemStr.toLowerCase().includes('propria') || origemStr.toLowerCase().includes('própria')
      ? 'own_brand'
      : 'third_party'

    // Check against ERP — report only once per unique product key (Tipo/Modelo
    // já canônicos, resolvidos contra o PIM — duas grafias diferentes do
    // mesmo Tipo/Modelo colidem corretamente como o mesmo produto)
    const productKey = `${nome_produto.trim().toLowerCase()}|${resolvedTipo}|${resolvedModelo}|${ano}`
    if (existingKeys.has(productKey) && !alreadyReportedErpConflict.has(productKey)) {
      alreadyReportedErpConflict.add(productKey)
      newIssues.push({
        row: rowNum,
        message: `Produto '${nome_produto.trim()}' já existe no ERP com este tipo, modelo e ano. Remova-o do CSV.`,
        type: 'error',
      })
    }

    // SKU de variação: chave única por cor+tamanho dentro do mesmo produto (só para detecção de duplicatas no preview)
    const sku_variacao = `${corStr}-${tamanhoStr}`.toLowerCase().replace(/\s+/g, '_')
    const mapKey = nome_produto.trim().toLowerCase()

    if (!productMap.has(mapKey)) {
      productMap.set(mapKey, {
        name: nome_produto.trim(),
        tipo: resolvedTipo,
        modelo: resolvedModelo,
        ano,
        category_id,
        supplier_id,
        origin,
        base_cost:  pCusto,
        base_price: pPreco,
        active: ativo,
        variants: [],
      })
    }

    const product = productMap.get(mapKey)!

    const duplicateVariant = product.variants.some(v => v.sku_variation === sku_variacao)
    if (duplicateVariant) {
      newIssues.push({
        row: rowNum,
        message: `"${nome_produto.trim()}" — cor+tamanho duplicados no CSV: ${corStr || '(sem cor)'} / ${tamanhoStr || '(sem tamanho)'}`,
        type: 'error',
      })
    } else {
      product.variants.push({
        sku_variation: sku_variacao,
        color_value_id,
        size_value_id,
        cost_override:  pCusto !== product.base_cost  ? pCusto  : undefined,
        price_override: pPreco !== product.base_price ? pPreco  : undefined,
        initial_stock: estoque,
      })
    }
  })

  // Conflito de SKU-pai entre produtos diferentes do CSV NÃO é mais
  // validado aqui: desde a introdução do ledger product_sku_identities,
  // vários produtos podem legitimamente compartilhar o mesmo sku_base —
  // cada um recebe um discriminator diferente, resolvido pela RPC
  // (rpc_import_products_batch → _resolve_product_sku_identity). Bloquear
  // isso na prévia seria rejeitar um caso agora válido.

  const hasErrors = newIssues.some(i => i.type === 'error')

  return {
    parsedProducts: Array.from(productMap.values()),
    issues: newIssues,
    hasErrors,
  }
}
