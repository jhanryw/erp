import { describe, it, expect } from 'vitest'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { loadWholesaleAdminSummaries, loadWholesaleProductDetail, summarizeWholesaleStatus } from './adminStatus'

const COMPANY = 1

interface P { id: number; active?: boolean; enabled?: boolean; price?: number | null; variations?: { id: number; active?: boolean; override?: number | null; stock?: number }[]; image?: boolean }

function build(specs: P[]) {
  const tables: FakeTables = {
    products: [], product_variations: [], stock_balances: [], media: [], media_usages: [],
    stock_locations: [{ id: 1, company_id: COMPANY, active: true }],
  }
  for (const s of specs) {
    tables.products.push({ id: s.id, company_id: COMPANY, active: s.active ?? true, wholesale_enabled: s.enabled ?? true, wholesale_price: s.price === undefined ? 20 : s.price, base_price: 50 })
    for (const v of s.variations ?? [{ id: s.id * 10 }]) {
      tables.product_variations.push({ id: v.id, product_id: s.id, sku_variation: `S${v.id}`, active: v.active ?? true, price_override: null, wholesale_price_override: v.override ?? null })
      tables.stock_balances.push({ product_variation_id: v.id, stock_location_id: 1, quantity: v.stock ?? 5 })
    }
    if (s.image) {
      tables.media.push({ id: s.id, active: true })
      tables.media_usages.push({ id: s.id, entity_type: 'product', entity_id: String(s.id), company_id: COMPANY, role: 'gallery', media_id: s.id })
    }
  }
  return createFakeAdmin(tables) as any
}

const toProduct = (s: P) => ({ id: s.id, active: s.active ?? true, wholesale_enabled: s.enabled ?? true, wholesale_price: s.price === undefined ? 20 : s.price })

async function statusOf(spec: P) {
  const map = await loadWholesaleAdminSummaries(build([spec]), COMPANY, [toProduct(spec)])
  return map.get(spec.id)!
}

describe('status comercial do atacado (admin)', () => {
  it('ativo e vendável', async () => {
    expect(await statusOf({ id: 1 })).toMatchObject({ status: 'sellable', sellableVariations: 1 })
  })
  it('ativo sem preço → no_price', async () => {
    expect((await statusOf({ id: 1, price: null })).status).toBe('no_price')
  })
  it('ativo sem estoque → no_stock', async () => {
    expect((await statusOf({ id: 1, variations: [{ id: 10, stock: 0 }] })).status).toBe('no_stock')
  })
  it('wholesale_enabled false → disabled (independente de preço/estoque)', async () => {
    expect((await statusOf({ id: 1, enabled: false })).status).toBe('disabled')
  })
  it('produto globalmente inativo → inactive (tem precedência)', async () => {
    expect((await statusOf({ id: 1, active: false, enabled: false })).status).toBe('inactive')
  })
  it('habilitado sem nenhuma variação ativa → no_variations', async () => {
    expect((await statusOf({ id: 1, variations: [{ id: 10, active: false }] })).status).toBe('no_variations')
  })
  it('override de variação vale como preço: sem preço no produto mas com override e estoque → vendável', async () => {
    expect((await statusOf({ id: 1, price: null, variations: [{ id: 10, override: 15 }] })).status).toBe('sellable')
  })
  it('uma variação vendável basta (outra sem estoque não rebaixa o produto)', async () => {
    expect((await statusOf({ id: 1, variations: [{ id: 10, stock: 3 }, { id: 11, stock: 0 }] })).status).toBe('sellable')
  })
  it('hasImage reflete primary/gallery ativa', async () => {
    expect((await statusOf({ id: 1, image: true })).hasImage).toBe(true)
    expect((await statusOf({ id: 2 })).hasImage).toBe(false)
  })

  it('sem N+1: 60 produtos → número constante de consultas', async () => {
    const specs: P[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, image: i % 2 === 0 }))
    const admin = build(specs)
    const map = await loadWholesaleAdminSummaries(admin, COMPANY, specs.map(toProduct))
    expect(map.size).toBe(60)
    expect(admin.queryCount.product_variations).toBe(1)
    expect(admin.queryCount.stock_balances).toBe(1)
    expect(admin.queryCount.media_usages).toBe(1)
  })

  it('summarizeWholesaleStatus é puro e usa as condições próprias das variações', () => {
    expect(summarizeWholesaleStatus({ active: true, wholesale_enabled: true }, ['no_stock', 'no_price'])).toBe('no_stock')
    expect(summarizeWholesaleStatus({ active: true, wholesale_enabled: true }, [])).toBe('no_variations')
  })
})

describe('detalhe por variação (tela de edição)', () => {
  it('mostra estoque, varejo, atacado e status de cada variação', async () => {
    const spec: P = { id: 1, variations: [{ id: 10, stock: 3 }, { id: 11, stock: 0 }, { id: 12, stock: 4 }] }
    const admin = build([spec])
    // G (12) sem preço: preço do produto null e sem override → força via override inexistente
    const detail = await loadWholesaleProductDetail(admin, COMPANY, { ...toProduct(spec), base_price: 50 })
    expect(detail.variations.map((v) => [v.stock, v.retailPrice, v.wholesalePrice, v.status])).toEqual([
      [3, 50, 20, 'sellable'], [0, 50, 20, 'no_stock'], [4, 50, 20, 'sellable'],
    ])
    expect(detail.status).toBe('sellable')

    const noPrice = await loadWholesaleProductDetail(build([{ id: 1, price: null }]), COMPANY, { ...toProduct({ id: 1, price: null }), base_price: 50 })
    expect(noPrice.variations[0]).toMatchObject({ wholesalePrice: null, status: 'no_price' })
  })
})
