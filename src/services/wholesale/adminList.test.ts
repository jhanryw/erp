import { describe, it, expect } from 'vitest'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { listProductsForAdmin, ADMIN_PAGE_SIZE } from './adminList'

const COMPANY = 1

interface P { id: number; company?: number; name?: string; active?: boolean; enabled?: boolean; price?: number | null; stock?: number; image?: boolean }

function build(specs: P[]) {
  const tables: FakeTables = {
    products: [], product_variations: [], stock_balances: [], media: [], media_usages: [],
    categories: [], suppliers: [], brands: [],
    stock_locations: [{ id: 1, company_id: 1, active: true }, { id: 2, company_id: 2, active: true }],
  }
  for (const s of specs) {
    const company = s.company ?? COMPANY
    tables.products.push({
      id: s.id, company_id: company, name: s.name ?? `P${String(s.id).padStart(4, '0')}`, sku: `SKU${s.id}`,
      base_cost: 10, base_price: 50, margin_pct: 80, photo_url: null, active: s.active ?? true,
      wholesale_enabled: s.enabled ?? false, wholesale_price: s.price === undefined ? 20 : s.price,
      category_id: null, supplier_id: null, brand_id: null,
    })
    tables.product_variations.push({ id: s.id * 10, product_id: s.id, sku_variation: `V${s.id}`, active: true, price_override: null, wholesale_price_override: null })
    tables.stock_balances.push({ product_variation_id: s.id * 10, stock_location_id: company === 1 ? 1 : 2, quantity: s.stock ?? 5 })
    if (s.image) {
      tables.media.push({ id: s.id, active: true })
      tables.media_usages.push({ id: s.id, entity_type: 'product', entity_id: String(s.id), company_id: company, role: 'primary', media_id: s.id })
    }
  }
  return createFakeAdmin(tables) as any
}
const ids = (r: { products: { id: number }[] }) => r.products.map((p) => p.id)

describe('listProductsForAdmin', () => {
  it('lista só produtos da empresa (tenant)', async () => {
    const r = await listProductsForAdmin(build([{ id: 1 }, { id: 2, company: 2 }]), COMPANY, {})
    expect(ids(r)).toEqual([1])
    expect(r.total).toBe(1)
  })

  it('filtro Atacado: ativos / inativos / todos', async () => {
    const admin = () => build([{ id: 1, enabled: true }, { id: 2, enabled: false }, { id: 3, enabled: true }])
    expect(ids(await listProductsForAdmin(admin(), COMPANY, { atacado: 'ativos' }))).toEqual([1, 3])
    expect(ids(await listProductsForAdmin(admin(), COMPANY, { atacado: 'inativos' }))).toEqual([2])
    expect(ids(await listProductsForAdmin(admin(), COMPANY, {}))).toEqual([1, 2, 3])
  })

  it('busca por nome/SKU continua funcionando junto com filtros', async () => {
    const admin = build([{ id: 1, name: 'Sutiã Rosa', enabled: true }, { id: 2, name: 'Sutiã Preto' }, { id: 3, name: 'Calcinha', enabled: true }])
    expect(ids(await listProductsForAdmin(admin, COMPANY, { search: 'sutiã' }))).toEqual([2, 1]) // ordem alfabética
    expect(ids(await listProductsForAdmin(admin, COMPANY, { search: 'sutiã', atacado: 'ativos' }))).toEqual([1])
    expect(ids(await listProductsForAdmin(admin, COMPANY, { search: 'a,b)(x' }))).toEqual([]) // caracteres de sintaxe não quebram
  })

  it('situação: vendáveis / sem preço / sem estoque / sem imagem (só habilitados)', async () => {
    const specs: P[] = [
      { id: 1, enabled: true, image: true },                    // vendável
      { id: 2, enabled: true, price: null, image: true },       // sem preço
      { id: 3, enabled: true, stock: 0, image: true },          // sem estoque
      { id: 4, enabled: true },                                 // vendável, sem imagem
      { id: 5, enabled: false, price: null },                   // desativado — fora de qualquer situação
    ]
    const run = (situacao: any) => listProductsForAdmin(build(specs), COMPANY, { situacao }).then(ids)
    expect(await run('vendaveis')).toEqual([1, 4])
    expect(await run('sem_preco')).toEqual([2])
    expect(await run('sem_estoque')).toEqual([3])
    expect(await run('sem_imagem')).toEqual([4])
  })

  it('situação nunca inclui produto de outra empresa', async () => {
    const r = await listProductsForAdmin(build([{ id: 1, enabled: true, image: true }, { id: 2, company: 2, enabled: true }]), COMPANY, { situacao: 'vendaveis' })
    expect(ids(r)).toEqual([1])
  })

  it('paginação de 50 e status calculado em lote apenas para a página (sem N+1)', async () => {
    const admin = build(Array.from({ length: 120 }, (_, i) => ({ id: i + 1, enabled: true })))
    const page2 = await listProductsForAdmin(admin, COMPANY, { page: 2 })
    expect(page2.products).toHaveLength(ADMIN_PAGE_SIZE)
    expect(page2.total).toBe(120)
    expect(page2.totalPages).toBe(3)
    expect(page2.summaries.size).toBe(ADMIN_PAGE_SIZE)
    expect(admin.queryCount.product_variations).toBe(1)
    expect(admin.queryCount.stock_balances).toBe(1)
    expect(admin.queryCount.media_usages).toBe(1)
  })

  it('cada linha traz o status do atacado (inclui "ativo mas sem preço")', async () => {
    const r = await listProductsForAdmin(build([{ id: 1, enabled: true, price: null }, { id: 2, enabled: false }, { id: 3, active: false, enabled: true }]), COMPANY, {})
    expect([1, 2, 3].map((id) => r.summaries.get(id)!.status)).toEqual(['no_price', 'disabled', 'inactive'])
  })
})
