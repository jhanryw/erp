import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleRecommendations } from './catalog'
import { rankBySeed } from './recommendations'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntities: vi.fn() }))

const A = 1
const B = 2
const SETTINGS = {
  catalogActive: true, displayName: null, whatsappPhone: null, minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null,
}

describe('rankBySeed', () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1)

  it('determinístico: mesma seed, mesma ordem', () => {
    expect(rankBySeed(ids, 'abc')).toEqual(rankBySeed([...ids].reverse(), 'abc'))
  })

  it('seeds diferentes embaralham de forma diferente (varia entre sessões)', () => {
    expect(rankBySeed(ids, 'sessao-1')).not.toEqual(rankBySeed(ids, 'sessao-2'))
  })

  it('estável: tirar um item não reordena os demais', () => {
    const full = rankBySeed(ids, 'abc')
    const without = rankBySeed(ids.filter((id) => id !== full[1]), 'abc')
    expect(without).toEqual(full.filter((id) => id !== full[1]))
  })
})

interface Spec { id: number; company?: number; active?: boolean; enabled?: boolean; price?: number | null; stock?: number; variations?: { id: number; override?: number | null; stock?: number; active?: boolean }[] }

let tables: FakeTables
function setup(specs: Spec[], settings: Partial<typeof SETTINGS> = {}) {
  tables = {
    categories: [{ id: 1, company_id: A, name: 'Cat', slug: 'cat', active: true }],
    brands: [], variation_types: [], variation_values: [], products: [], product_variations: [], product_variation_attributes: [], stock_balances: [],
    stock_locations: [{ id: 1, company_id: A, active: true }, { id: 2, company_id: B, active: true }],
  }
  for (const s of specs) {
    tables.products.push({ id: s.id, name: `P${s.id}`, company_id: s.company ?? A, active: s.active ?? true, wholesale_enabled: s.enabled ?? true, wholesale_price: s.price === undefined ? 20 : s.price, category_id: 1, brand_id: null })
    for (const v of s.variations ?? [{ id: s.id * 10, stock: s.stock }]) {
      tables.product_variations.push({ id: v.id, product_id: s.id, sku_variation: `S${v.id}`, active: v.active ?? true, wholesale_price_override: v.override ?? null })
      tables.stock_balances.push({ product_variation_id: v.id, stock_location_id: (s.company ?? A) === A ? 1 : 2, quantity: v.stock ?? 5 })
    }
  }
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(createFakeAdmin(tables))
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SETTINGS, ...settings })
}

const ids = (products: { productId: number }[]) => products.map((p) => p.productId)

beforeEach(() => {
  vi.resetAllMocks()
  ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
})

describe('getWholesaleRecommendations', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }))

  it('devolve no máximo 6 produtos elegíveis', async () => {
    setup(many)
    expect(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' })).toHaveLength(6)
    expect(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's', limit: 4 })).toHaveLength(4)
    expect(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's', limit: 99 })).toHaveLength(6)
  })

  it('exclui produtos que já estão no carrinho (o produto inteiro, qualquer variação)', async () => {
    setup([{ id: 1, variations: [{ id: 10 }, { id: 11 }, { id: 12 }] }, ...many.slice(1)])
    const before = ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' }))
    const inCart = before.slice(0, 2) // os dois primeiros da fila entram no carrinho
    const after = ids(await getWholesaleRecommendations(A, { excludeProductIds: inCart, seed: 's' }))
    expect(after).toHaveLength(6)
    for (const id of inCart) expect(after).not.toContain(id)
  })

  it('exclui indisponíveis: sem estoque, inativo, oculto no atacado, sem preço, variação inativa', async () => {
    setup([
      { id: 1 },
      { id: 2, stock: 0 },
      { id: 3, active: false },
      { id: 4, enabled: false },
      { id: 5, price: null },
      { id: 6, variations: [{ id: 60, active: false }] },
    ])
    expect(ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' }))).toEqual([1])
  })

  it('mesmo com show_out_of_stock ligado nunca recomenda o que não dá para comprar', async () => {
    setup([{ id: 1 }, { id: 2, stock: 0 }], { showOutOfStock: true })
    expect(ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' }))).toEqual([1])
  })

  it('nunca expõe produto de outra empresa', async () => {
    setup([{ id: 1 }, { id: 2, company: B }, { id: 3, company: B }])
    expect(ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' }))).toEqual([1])
    expect(ids(await getWholesaleRecommendations(B, { excludeProductIds: [], seed: 's' })).sort()).toEqual([2, 3])
  })

  it('respeita as regras de preço do atacado (override por variação) e a disponibilidade por variação', async () => {
    setup([{ id: 1, price: 20, variations: [{ id: 10 }, { id: 11, override: 35 }, { id: 12, stock: 0 }] }])
    const [p] = await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' })
    const byId = Object.fromEntries(p.variations.map((v) => [v.variationId, v]))
    expect(byId[10]).toMatchObject({ price: 20, available: true, maxQuantity: 5 })
    expect(byId[11]).toMatchObject({ price: 35, available: true })
    expect(byId[12]).toMatchObject({ available: false, maxQuantity: 0 })
    expect(p.priceFrom).toBe(20)
  })

  it('estável durante a sessão: mesma seed → mesma lista; item que entra no carrinho só cede a vaga', async () => {
    setup(many)
    const first = ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 'sessao' }))
    expect(ids(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 'sessao' }))).toEqual(first)

    const afterAdd = ids(await getWholesaleRecommendations(A, { excludeProductIds: [first[2]], seed: 'sessao' }))
    expect(afterAdd.slice(0, 2)).toEqual(first.slice(0, 2))
    expect(afterAdd.slice(2, 5)).toEqual(first.slice(3, 6))
  })

  it('sem elegíveis → lista vazia', async () => {
    setup([{ id: 1, stock: 0 }])
    expect(await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' })).toEqual([])
  })

  it('carrega imagens só dos escolhidos (uma consulta em lote)', async () => {
    setup(many)
    await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's' })
    expect(listMediaByEntities).toHaveBeenCalledTimes(1)
    const requested = (listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(requested).toHaveLength(6)
  })
})
