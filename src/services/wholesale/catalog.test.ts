import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWholesaleSiteSettings } from './settings'
import { listMediaByEntity } from '@/services/media.service'
import { getWholesaleCatalogPage, listWholesaleCategories, getWholesaleProductDetail, WHOLESALE_PRIORITY_CATEGORY_SLUG } from './catalog'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntity: vi.fn() }))

const DEFAULT_SETTINGS = {
  catalogActive: true,
  displayName: null,
  whatsappPhone: null,
  minimumOrderAmount: 300,
  showOutOfStock: false,
  showStockQuantity: false,
  showSearch: true,
  showCategories: true,
  pixelEnabled: false,
  pixelId: null,
}

/** Chain genérica — qualquer método encadeável devolve a si mesma; resolve com as linhas fornecidas ao `await`. */
function fakeChain(rows: unknown[]) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'ilike', 'in', 'order', 'limit']) chain[m] = () => chain
  chain.then = (resolve: any) => resolve({ data: rows, error: null })
  return chain
}

interface Product {
  id: number
  name: string
  wholesale_price: number | null
  categories: { name: string; slug: string } | null
}

function mockCatalog(products: Product[], variationsByProduct: Record<number, { id: number; sku_variation: string; wholesale_price_override: number | null }[]>, stockByVariation: Record<number, number> = {}) {
  const allVariations = Object.entries(variationsByProduct).flatMap(([productId, variations]) =>
    variations.map((v) => ({ ...v, product_id: Number(productId), active: true })),
  )
  const stockRows = Object.entries(stockByVariation).map(([variationId, quantity]) => ({ product_variation_id: Number(variationId), quantity }))

  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'products') return fakeChain(products)
      if (table === 'product_variations') return fakeChain(allVariations)
      if (table === 'product_variation_attributes') return fakeChain([])
      if (table === 'stock_balances') return fakeChain(stockRows)
      return fakeChain([])
    },
  })
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SETTINGS)
  ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
}

const CALCINHA = { name: 'Calcinhas', slug: WHOLESALE_PRIORITY_CATEGORY_SLUG }
const BLUSA = { name: 'Blusas', slug: 'blusas' }

describe('getWholesaleCatalogPage — Calcinhas primeiro (seção 13)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('produtos de Calcinhas aparecem antes de outras categorias, mesmo fora de ordem alfabética', async () => {
    mockCatalog(
      [
        { id: 1, name: 'Blusa Alfa', wholesale_price: 50, categories: BLUSA },
        { id: 2, name: 'Calcinha Zeta', wholesale_price: 20, categories: CALCINHA },
      ],
      { 1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }], 2: [{ id: 20, sku_variation: 'CAL-1', wholesale_price_override: null }] },
      { 10: 5, 20: 5 },
    )

    const result = await getWholesaleCatalogPage(1)
    expect(result.products.map((p) => p.productId)).toEqual([2, 1])
  })

  it('sem Calcinhas disponível — catálogo continua na ordem normal (alfabética)', async () => {
    mockCatalog(
      [
        { id: 1, name: 'Blusa Alfa', wholesale_price: 50, categories: BLUSA },
        { id: 2, name: 'Bota Zeta', wholesale_price: 80, categories: { name: 'Botas', slug: 'botas' } },
      ],
      { 1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }], 2: [{ id: 20, sku_variation: 'BOT-1', wholesale_price_override: null }] },
      { 10: 5, 20: 5 },
    )

    const result = await getWholesaleCatalogPage(1)
    expect(result.products.map((p) => p.productId)).toEqual([1, 2])
  })

  it('nenhum category_id numérico hardcoded — a prioridade é só por slug', async () => {
    mockCatalog(
      [{ id: 1, name: 'Calcinha Fio', wholesale_price: 20, categories: { name: 'Outra coisa chamada calcinha', slug: 'nao-e-a-prioritaria' } }],
      { 1: [{ id: 10, sku_variation: 'CAL-1', wholesale_price_override: null }] },
      { 10: 5 },
    )

    const result = await getWholesaleCatalogPage(1)
    expect(result.products[0].categorySlug).toBe('nao-e-a-prioritaria')
  })

  it('busca e filtro de categoria explícito NÃO reordenam por prioridade (intenção do cliente já é a busca)', async () => {
    mockCatalog(
      [{ id: 1, name: 'Blusa Alfa', wholesale_price: 50, categories: BLUSA }],
      { 1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }] },
      { 10: 5 },
    )

    const result = await getWholesaleCatalogPage(1, { search: 'blusa' })
    expect(result.products.map((p) => p.productId)).toEqual([1])
  })

  it('produto sem estoque some da vitrine por padrão (show_out_of_stock=false)', async () => {
    mockCatalog(
      [{ id: 1, name: 'Calcinha Sem Estoque', wholesale_price: 20, categories: CALCINHA }],
      { 1: [{ id: 10, sku_variation: 'CAL-1', wholesale_price_override: null }] },
      { 10: 0 },
    )

    const result = await getWholesaleCatalogPage(1)
    expect(result.products).toHaveLength(0)
  })
})

describe('listWholesaleCategories — Calcinhas com prioridade na navegação', () => {
  afterEach(() => vi.restoreAllMocks())

  it('categoria Calcinhas vem primeiro na lista de navegação', async () => {
    mockCatalog(
      [
        { id: 1, name: 'Blusa', wholesale_price: 50, categories: BLUSA },
        { id: 2, name: 'Calcinha', wholesale_price: 20, categories: CALCINHA },
        { id: 3, name: 'Acessório', wholesale_price: 10, categories: { name: 'Acessórios', slug: 'acessorios' } },
      ],
      {
        1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }],
        2: [{ id: 20, sku_variation: 'CAL-1', wholesale_price_override: null }],
        3: [{ id: 30, sku_variation: 'ACE-1', wholesale_price_override: null }],
      },
      { 10: 5, 20: 5, 30: 5 },
    )

    const categories = await listWholesaleCategories(1)
    expect(categories.map((c) => c.slug)).toEqual([WHOLESALE_PRIORITY_CATEGORY_SLUG, 'acessorios', 'blusas'])
  })

  it('nunca duplica categoria mesmo com vários produtos na mesma categoria', async () => {
    mockCatalog(
      [
        { id: 1, name: 'Blusa A', wholesale_price: 50, categories: BLUSA },
        { id: 2, name: 'Blusa B', wholesale_price: 50, categories: BLUSA },
      ],
      { 1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }], 2: [{ id: 20, sku_variation: 'BLU-2', wholesale_price_override: null }] },
      { 10: 5, 20: 5 },
    )

    const categories = await listWholesaleCategories(1)
    expect(categories).toHaveLength(1)
  })

  it('não mostra categoria sem nenhum produto comprável', async () => {
    mockCatalog(
      [{ id: 1, name: 'Blusa sem preço atacado', wholesale_price: null, categories: BLUSA }],
      { 1: [{ id: 10, sku_variation: 'BLU-1', wholesale_price_override: null }] },
      { 10: 5 },
    )

    const categories = await listWholesaleCategories(1)
    expect(categories).toHaveLength(0)
  })
})

// ─── getWholesaleProductDetail ──────────────────────────────────────────────

interface DetailFixture {
  product: any
  variations: any[]
  attrs?: any[]
  stock?: any[]
}

function mockProductDetail({ product, variations, attrs = [], stock = [] }: DetailFixture) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'products') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: product, error: null }) }) }) }),
          }),
        }
      }
      if (table === 'product_variations') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: variations, error: null }) }) }) }
      }
      if (table === 'product_variation_attributes') {
        return { select: () => ({ in: async () => ({ data: attrs, error: null }) }) }
      }
      if (table === 'stock_balances') {
        return { select: () => ({ in: () => ({ eq: () => ({ eq: async () => ({ data: stock, error: null }) }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SETTINGS)
}

describe('getWholesaleProductDetail', () => {
  afterEach(() => vi.restoreAllMocks())

  it('2. produto sem wholesale_price nem override → nenhuma variação disponível, purchasable=false', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({
      product: { id: 1, name: 'Camisola', wholesale_price: null, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 10 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.purchasable).toBe(false)
    expect(result?.variations[0].available).toBe(false)
    expect(result?.priceFrom).toBeNull()
  })

  it('3. override da variação vence o preço do produto', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: 45, active: true }],
      stock: [{ product_variation_id: 10, quantity: 10 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].price).toBe(45)
  })

  it('6. estoque zero → indisponível mesmo com preço cadastrado', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 0 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].available).toBe(false)
    expect(result?.purchasable).toBe(false)
  })

  it('baixo estoque (<= 3) sinaliza lowStock, mas continua disponível', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 2 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].available).toBe(true)
    expect(result?.variations[0].lowStock).toBe(true)
  })

  it('45/46. DTO público nunca expõe custo/margem/NCM/CST/estoque exato/IDs administrativos', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 7 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    const serialized = JSON.stringify(result)
    for (const forbidden of ['base_cost', 'cost_override', 'wholesale_price"', 'ncm', 'cst', 'margin', 'company_id']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    // Estoque exato nunca aparece — só available/lowStock (booleanos) — a menos que a empresa habilite show_stock_quantity (default false aqui).
    expect(serialized).not.toContain('"7"')
    expect(result?.variations[0]).toEqual({
      variationId: 10, sku: 'SKU-1', attributes: [], price: 50, available: true, lowStock: false,
    })
  })

  it('produto inativo/inexistente → null', async () => {
    ;(listMediaByEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
    mockProductDetail({ product: null, variations: [] })
    const result = await getWholesaleProductDetail(1, 999)
    expect(result).toBeNull()
  })
})
