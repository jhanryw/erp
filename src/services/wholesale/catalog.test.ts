import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, type FakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleCatalogPage, listWholesaleCategories, getWholesaleProductDetail, WHOLESALE_PRIORITY_CATEGORY_SLUG } from './catalog'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntities: vi.fn() }))

const COMPANY = 1
const OTHER_COMPANY = 2

const SETTINGS = {
  catalogActive: true, displayName: null, whatsappPhone: null, minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true,
  pixelEnabled: false, pixelId: null,
}

const CATEGORIES = [
  { id: 1, name: 'Calcinhas', slug: WHOLESALE_PRIORITY_CATEGORY_SLUG },
  { id: 2, name: 'Blusas', slug: 'blusas' },
]

interface ProductSpec {
  id: number
  name?: string
  company?: number
  active?: boolean
  enabled?: boolean
  price?: number | null
  category?: number
  /** variações: [id, { active?, override?, stock? }] */
  variations?: { id: number; active?: boolean; override?: number | null; stock?: number; stockCompany?: number }[]
}

/** Monta as tabelas do fake. Default: produto ativo + habilitado + preço 20 + 1 variação com estoque 5. */
function world(specs: ProductSpec[]): { tables: FakeTables } {
  const tables: FakeTables = {
    categories: CATEGORIES, brands: [], variation_types: [], variation_values: [],
    products: [], product_variations: [], product_variation_attributes: [], stock_balances: [],
    stock_locations: [
      { id: 1, company_id: COMPANY, active: true },
      { id: 2, company_id: OTHER_COMPANY, active: true },
      { id: 3, company_id: COMPANY, active: false },
    ],
  }
  for (const s of specs) {
    tables.products.push({
      id: s.id, name: s.name ?? `Produto ${s.id}`, company_id: s.company ?? COMPANY,
      active: s.active ?? true, wholesale_enabled: s.enabled ?? true,
      wholesale_price: s.price === undefined ? 20 : s.price, category_id: s.category ?? 2, brand_id: null,
    })
    for (const v of s.variations ?? [{ id: s.id * 10 }]) {
      tables.product_variations.push({
        id: v.id, product_id: s.id, sku_variation: `SKU-${v.id}`, active: v.active ?? true,
        wholesale_price_override: v.override ?? null,
      })
      tables.stock_balances.push({
        product_variation_id: v.id, stock_location_id: v.stockCompany === OTHER_COMPANY ? 2 : 1, quantity: v.stock ?? 5,
      })
    }
  }
  return { tables }
}

let admin: FakeAdmin
function setup(specs: ProductSpec[], settings: Partial<typeof SETTINGS> = {}, options?: { maxRows?: number }) {
  admin = createFakeAdmin(world(specs).tables, options)
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SETTINGS, ...settings })
}

const ids = (page: { products: { productId: number }[] }) => page.products.map((p) => p.productId)

beforeEach(() => {
  vi.resetAllMocks()
  ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
})

describe('catálogo — só produtos habilitados no atacado', () => {
  it('1. produto ativo + atacado false → não aparece', async () => {
    setup([{ id: 1, enabled: false }])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([])
  })

  it('2. produto ativo + atacado true → aparece', async () => {
    setup([{ id: 1 }])
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(ids(page)).toEqual([1])
    expect(page.products[0]).toMatchObject({ purchasable: true, priceFrom: 20 })
  })

  it('3. produto inativo + atacado true → não aparece', async () => {
    setup([{ id: 1, active: false }])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([])
  })

  it('4. atacado true + sem preço de atacado → não vendável (oculto; visível mas indisponível com show_out_of_stock)', async () => {
    setup([{ id: 1, price: null }])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([])

    setup([{ id: 1, price: null }], { showOutOfStock: true })
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(page.products[0]).toMatchObject({ purchasable: false, priceFrom: null })
    expect(page.products[0].variations[0].available).toBe(false)
  })

  it('5. atacado true + variação inativa → variação não aparece', async () => {
    setup([{ id: 1, variations: [{ id: 10 }, { id: 11, active: false }] }])
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(page.products[0].variations.map((v) => v.variationId)).toEqual([10])
  })

  it('6. atacado true + estoque zero → respeita show_out_of_stock', async () => {
    setup([{ id: 1, variations: [{ id: 10, stock: 0 }] }])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([])

    setup([{ id: 1, variations: [{ id: 10, stock: 0 }] }], { showOutOfStock: true })
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(ids(page)).toEqual([1])
    expect(page.products[0].purchasable).toBe(false)
  })

  it('7. acesso direto a produto atacado false → null (404), e a API pública não devolve o produto', async () => {
    setup([{ id: 1, enabled: false }, { id: 2 }])
    expect(await getWholesaleProductDetail(COMPANY, 1)).toBeNull()
    expect(await getWholesaleProductDetail(COMPANY, 2)).toMatchObject({ productId: 2 })
  })

  it('7b. detalhe de produto inativo → null', async () => {
    setup([{ id: 1, active: false }])
    expect(await getWholesaleProductDetail(COMPANY, 1)).toBeNull()
  })

  it('8. busca não encontra produto atacado false', async () => {
    setup([{ id: 1, name: 'Sutiã Rosa', enabled: false }, { id: 2, name: 'Sutiã Preto' }])
    expect(ids(await getWholesaleCatalogPage(COMPANY, { search: 'sutiã' }))).toEqual([2])
  })

  it('9. categoria não encontra produto atacado false, e retorna só produtos da categoria pedida', async () => {
    setup([
      { id: 1, name: 'A1', category: 1 },
      { id: 2, name: 'A2 fora do atacado', category: 1, enabled: false },
      { id: 3, name: 'B1', category: 2 },
    ])
    expect(ids(await getWholesaleCatalogPage(COMPANY, { categorySlug: WHOLESALE_PRIORITY_CATEGORY_SLUG }))).toEqual([1])
    expect(ids(await getWholesaleCatalogPage(COMPANY, { categorySlug: 'blusas' }))).toEqual([3])
  })

  it('9b. categoria A retorna SOMENTE produtos da categoria A (filtro reduz, não só zera o embed)', async () => {
    setup([
      { id: 1, category: 1 }, { id: 2, category: 1 }, { id: 3, category: 2 }, { id: 4, category: 2 },
    ])
    const page = await getWholesaleCatalogPage(COMPANY, { categorySlug: 'blusas' })
    expect(ids(page)).toEqual([3, 4])
    expect(page.total).toBe(2)
    expect(page.products.every((p) => p.categorySlug === 'blusas')).toBe(true)
  })

  it('lista de categorias ignora categoria que só tem produto fora do atacado', async () => {
    setup([{ id: 1, category: 1, enabled: false }, { id: 2, category: 2 }])
    expect((await listWholesaleCategories(COMPANY)).map((c) => c.slug)).toEqual(['blusas'])
  })

  it('Calcinhas primeiro fora de busca/categoria', async () => {
    setup([{ id: 1, name: 'Blusa Alfa', category: 2 }, { id: 2, name: 'Calcinha Zeta', category: 1 }])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([2, 1])
  })

  it('15. isolamento entre empresas: produto/estoque de outra empresa nunca aparece', async () => {
    setup([
      { id: 1, company: OTHER_COMPANY },
      { id: 2, variations: [{ id: 20, stock: 9, stockCompany: OTHER_COMPANY }] }, // produto meu, estoque só na empresa 2
    ])
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([]) // estoque de outra empresa não conta
    expect(await getWholesaleProductDetail(COMPANY, 1)).toBeNull()
    expect(await getWholesaleProductDetail(OTHER_COMPANY, 1)).toMatchObject({ productId: 1 })
  })

  it('estoque em local inativo não conta', async () => {
    // saldo movido para o local inativo (id 3)
    const tables = world([{ id: 1 }]).tables
    tables.stock_balances[0].stock_location_id = 3
    admin = createFakeAdmin(tables)
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
    ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS)
    expect(ids(await getWholesaleCatalogPage(COMPANY))).toEqual([])
  })
})

describe('catálogo — limite de quantidade por variação', () => {
  it('maxQuantity = estoque atual da variação vendável (0 quando indisponível); stockQuantity só se configurado', async () => {
    setup([{ id: 1, variations: [{ id: 10, stock: 3 }, { id: 11, stock: 0 }] }])
    const v = (await getWholesaleCatalogPage(COMPANY)).products[0].variations
    expect(v.map((x) => [x.maxQuantity, x.stockQuantity])).toEqual([[3, undefined], [0, undefined]])

    setup([{ id: 1, variations: [{ id: 10, stock: 3 }] }], { showStockQuantity: true })
    expect((await getWholesaleCatalogPage(COMPANY)).products[0].variations[0]).toMatchObject({ maxQuantity: 3, stockQuantity: 3 })
  })
})

describe('catálogo — 1000 linhas e paginação', () => {
  it('13. mais de 1000 variações/saldos de estoque não causam truncamento (maxRows=1000 simulado)', async () => {
    const specs: ProductSpec[] = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, name: `P${String(i + 1).padStart(4, '0')}` }))
    setup(specs, {}, { maxRows: 1000 })

    const page = await getWholesaleCatalogPage(COMPANY, { pageSize: 60 })
    expect(page.total).toBe(1200) // sem truncar em 1000
    expect(page.products).toHaveLength(60)

    const last = await getWholesaleCatalogPage(COMPANY, { page: 20, pageSize: 60 })
    expect(last.products).toHaveLength(60)
    expect(last.products[59].productId).toBe(1200)
    expect(last.products.every((p) => p.purchasable)).toBe(true)
  })

  it('13b. produto com mais de 1000 variações mantém todas no detalhe', async () => {
    const variations = Array.from({ length: 1100 }, (_, i) => ({ id: 1000 + i }))
    setup([{ id: 1, variations }], {}, { maxRows: 1000 })
    const detail = await getWholesaleProductDetail(COMPANY, 1)
    expect(detail?.variations).toHaveLength(1100)
    expect(detail?.variations.every((v) => v.available)).toBe(true)
  })

  it('paginação: página 2 traz o restante e total reflete só os visíveis', async () => {
    setup(Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `P${i + 1}` })))
    const page2 = await getWholesaleCatalogPage(COMPANY, { page: 2, pageSize: 2 })
    expect(ids(page2)).toEqual([3, 4])
    expect(page2.total).toBe(5)
  })
})

describe('catálogo — imagens', () => {
  const media = (entity: number, role: string, url: string, position = 0) => ({
    entity_id: String(entity), role, position, url, alt_text: null, active: true,
  })

  it('14. imagem primary tem prioridade sobre gallery (mesmo que gallery venha antes)', async () => {
    setup([{ id: 1 }])
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [media(1, 'gallery', 'g1', 0), media(1, 'gallery', 'g2', 1), media(1, 'primary', 'p', 0)],
    })
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(page.products[0].images.map((i) => i.url)).toEqual(['p', 'g1', 'g2'])
  })

  it('sem primary usa gallery como capa; sem imagem → lista vazia (placeholder)', async () => {
    setup([{ id: 1 }, { id: 2 }])
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [media(1, 'gallery', 'g1')] })
    const page = await getWholesaleCatalogPage(COMPANY)
    expect(page.products[0].images[0].url).toBe('g1')
    expect(page.products[1].images).toEqual([])
  })

  it('mídia inativa e roles não-produto são ignoradas', async () => {
    setup([{ id: 1 }])
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ ...media(1, 'primary', 'off'), active: false }, media(1, 'proof', 'x'), media(1, 'gallery', 'ok')],
    })
    expect((await getWholesaleCatalogPage(COMPANY)).products[0].images.map((i) => i.url)).toEqual(['ok'])
  })

  it('sem N+1: 24 produtos na página → UMA consulta de mídia em lote', async () => {
    setup(Array.from({ length: 24 }, (_, i) => ({ id: i + 1 })))
    await getWholesaleCatalogPage(COMPANY, { pageSize: 24 })
    expect(listMediaByEntities).toHaveBeenCalledTimes(1)
    const [, entityIds] = (listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(entityIds).toHaveLength(24)
  })

  it('falha na mídia não derruba o catálogo (produto fica sem imagem)', async () => {
    setup([{ id: 1 }])
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'x', status: 500 })
    expect((await getWholesaleCatalogPage(COMPANY)).products[0].images).toEqual([])
  })
})
