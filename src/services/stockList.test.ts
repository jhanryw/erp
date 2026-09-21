import { describe, it, expect } from 'vitest'
import { createFakeAdmin, type FakeTables } from './wholesale/fakeSupabase.testutil'
import { getMultiStockData } from './stockList'

const COMPANY = 1
const LOC = (id: number, name: string, main = false) => ({ location_id: id, location_name: name, slug: name.toLowerCase(), is_main_store: main, priority: id, quantity: 1 })

interface V { id: number; product: number; name: string; supplier?: number | null; company?: number; qty?: number; sku?: string; tamanho?: string | null; cor?: string | null; main?: number }

function build(variations: V[], options?: { maxRows?: number }) {
  const tables: FakeTables = { products: [], vw_stock_live_multi: [], stock_locations: [
    { id: 1, company_id: 1, name: 'Estoque Loja', slug: 'estoque-loja', is_main_store: true, active: true, priority: 1 },
    { id: 2, company_id: 1, name: 'Depósito', slug: 'deposito', is_main_store: false, active: true, priority: 2 },
    { id: 3, company_id: 1, name: 'Inativo', slug: 'inativo', is_main_store: false, active: false, priority: 3 },
    { id: 4, company_id: 2, name: 'Outra Empresa', slug: 'outra', is_main_store: true, active: true, priority: 1 },
  ] }
  for (const v of variations) {
    const company = v.company ?? COMPANY
    if (!tables.products.find((p) => p.id === v.product)) tables.products.push({ id: v.product, company_id: company, supplier_id: v.supplier ?? null })
    tables.vw_stock_live_multi.push({
      product_variation_id: v.id, product_id: v.product, product_name: v.name, sku_variation: v.sku ?? `SKU-${v.id}`, sku_parent: `P${v.product}`,
      tamanho: v.tamanho ?? null, cor: v.cor ?? null, company_id: company, total_qty: v.qty ?? 5, main_store_qty: v.main ?? 5,
      needs_transfer: (v.qty ?? 5) > 0 && (v.main ?? 5) === 0, total_stock_value_at_cost: 10 * (v.qty ?? 5), total_stock_value_at_price: 20 * (v.qty ?? 5),
      last_entry_date: null, balances_by_location: [LOC(1, 'Estoque Loja', true), LOC(2, 'Depósito')],
    })
  }
  return createFakeAdmin(tables, options) as any
}
const ids = (r: { items: { product_variation_id: number }[] }) => r.items.map((i) => i.product_variation_id)

const BASE: V[] = [
  { id: 1, product: 1, name: 'Sutiã Maria', supplier: 1, tamanho: 'M' },
  { id: 2, product: 1, name: 'Sutiã Maria', supplier: 1, tamanho: 'G' },
  { id: 3, product: 2, name: 'Calcinha Doce', supplier: 2 },
  { id: 4, product: 3, name: 'Body Sem Fornecedor', supplier: null },
  { id: 5, product: 4, name: 'Calcinha Outra Empresa', supplier: 1, company: 2 },
]

describe('getMultiStockData — filtro por fornecedor', () => {
  it('sem filtro: todos os fornecedores da EMPRESA (nunca de outra empresa)', async () => {
    expect(ids(await getMultiStockData(build(BASE), COMPANY, {})).sort()).toEqual([1, 2, 3, 4])
  })

  it('fornecedor A: só o estoque dos produtos do fornecedor A', async () => {
    const r = await getMultiStockData(build(BASE), COMPANY, { supplierId: 1 })
    expect(ids(r)).toEqual([2, 1]) // Sutiã Maria G, depois M (ordem por nome/tamanho)
    expect(r.items.every((i) => i.product_name === 'Sutiã Maria')).toBe(true)
  })

  it('produto de outro fornecedor e produto sem fornecedor não aparecem', async () => {
    const r = await getMultiStockData(build(BASE), COMPANY, { supplierId: 2 })
    expect(ids(r)).toEqual([3])
  })

  it('produto de OUTRA empresa não aparece, mesmo com o mesmo supplier_id', async () => {
    const r = await getMultiStockData(build(BASE), COMPANY, { supplierId: 1 })
    expect(ids(r)).not.toContain(5)
    expect(ids(await getMultiStockData(build(BASE), 2, { supplierId: 1 }))).toEqual([5]) // a empresa 2 só enxerga o dela
  })

  it('fornecedor inexistente/de outro tenant → lista vazia (sem erro, sem vazar)', async () => {
    const r = await getMultiStockData(build(BASE), COMPANY, { supplierId: 999 })
    expect(r.items).toEqual([])
    expect(r).toMatchObject({ productCount: 0, totalQty: 0, alertCount: 0 })
    expect(r.locations.length).toBeGreaterThan(0)
  })

  it('funciona com a posição por localização: locais ativos DA EMPRESA e saldos por local preservados', async () => {
    const r = await getMultiStockData(build(BASE), COMPANY, { supplierId: 1 })
    expect(r.locations.map((l) => l.name)).toEqual(['Estoque Loja', 'Depósito']) // sem inativo e sem local de outra empresa
    expect(r.items[0].balances_by_location.map((b) => b.location_name)).toEqual(['Estoque Loja', 'Depósito'])
  })

  it('busca + fornecedor funcionam juntos', async () => {
    const admin = () => build(BASE)
    expect(ids(await getMultiStockData(admin(), COMPANY, { supplierId: 2, search: 'calcinha' }))).toEqual([3])
    expect(ids(await getMultiStockData(admin(), COMPANY, { supplierId: 1, search: 'calcinha' }))).toEqual([])
    expect(ids(await getMultiStockData(admin(), COMPANY, { supplierId: 1, search: 'SKU-2' }))).toEqual([2]) // por SKU
  })

  it('busca sem fornecedor continua igual (só da empresa)', async () => {
    expect(ids(await getMultiStockData(build(BASE), COMPANY, { search: 'calcinha' }))).toEqual([3])
  })

  it('os cards (produtos, quantidade, valores, alertas) refletem o fornecedor filtrado', async () => {
    const admin = () => build([
      { id: 1, product: 1, name: 'A', supplier: 1, qty: 2, main: 0 },   // alerta (<=3) + precisa transferir
      { id: 2, product: 1, name: 'A', supplier: 1, qty: 10 },
      { id: 3, product: 2, name: 'B', supplier: 2, qty: 100 },
    ])
    const all = await getMultiStockData(admin(), COMPANY, {})
    const s1 = await getMultiStockData(admin(), COMPANY, { supplierId: 1 })
    expect(all).toMatchObject({ productCount: 2, totalQty: 112 })
    expect(s1).toMatchObject({ productCount: 1, totalQty: 12, totalCostValue: 120, totalSaleValue: 240, alertCount: 1, needsTransferCount: 1 })
  })

  it('sem N+1: uma consulta a `products` e leituras da view em lote, independente do nº de linhas', async () => {
    const admin = build(Array.from({ length: 60 }, (_, i) => ({ id: i + 1, product: i + 1, name: `P${i}`, supplier: 1 })))
    const r = await getMultiStockData(admin, COMPANY, { supplierId: 1 })
    expect(r.items).toHaveLength(60)
    expect(admin.queryCount.products).toBe(1)
    expect(admin.queryCount.vw_stock_live_multi).toBeLessThanOrEqual(2 * 1) // itens + resumo (1 lote de 60 produtos cada)
  })

  it('mais de 1000 linhas (limite do PostgREST): nada é truncado, com ou sem fornecedor, e a ordem se mantém', async () => {
    const many: V[] = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, product: Math.floor(i / 10) + 1, name: `Produto ${String(Math.floor(i / 10) + 1).padStart(4, '0')}`, supplier: 1 }))
    const withSupplier = await getMultiStockData(build(many, { maxRows: 1000 }), COMPANY, { supplierId: 1 })
    expect(withSupplier.items).toHaveLength(1500)
    expect(withSupplier.totalQty).toBe(7500)
    const names = withSupplier.items.map((i) => i.product_name)
    expect([...names].sort()).toEqual(names)
    const without = await getMultiStockData(build(many, { maxRows: 1000 }), COMPANY, {})
    expect(without.items).toHaveLength(1500)
    expect(without.totalQty).toBe(7500)
  })
})
