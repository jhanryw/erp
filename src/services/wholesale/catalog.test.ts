import { describe, it, expect, vi, afterEach } from 'vitest'
import { getWholesaleProductDetail } from './catalog'
import { createAdminClient } from '@/lib/supabase/admin'
import * as mediaService from '@/services/media.service'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

interface Fixture {
  product: any
  variations: any[]
  attrs?: any[]
  stock?: any[]
}

function mockCatalog({ product, variations, attrs = [], stock = [] }: Fixture) {
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
}

describe('getWholesaleProductDetail', () => {
  afterEach(() => vi.restoreAllMocks())

  it('2. produto sem wholesale_price nem override → nenhuma variação disponível, purchasable=false', async () => {
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({
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
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: 45, active: true }],
      stock: [{ product_variation_id: 10, quantity: 10 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].price).toBe(45)
  })

  it('6. estoque zero → indisponível mesmo com preço cadastrado', async () => {
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 0 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].available).toBe(false)
    expect(result?.purchasable).toBe(false)
  })

  it('baixo estoque (<= 3) sinaliza lowStock, mas continua disponível', async () => {
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 2 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    expect(result?.variations[0].available).toBe(true)
    expect(result?.variations[0].lowStock).toBe(true)
  })

  it('45/46. DTO público nunca expõe custo/margem/NCM/CST/estoque exato/IDs administrativos', async () => {
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({
      product: { id: 1, name: 'Camisola', wholesale_price: 50, brands: null, categories: null },
      variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-1', wholesale_price_override: null, active: true }],
      stock: [{ product_variation_id: 10, quantity: 7 }],
    })
    const result = await getWholesaleProductDetail(1, 1)
    const serialized = JSON.stringify(result)
    for (const forbidden of ['base_cost', 'cost_override', 'wholesale_price"', 'ncm', 'cst', 'margin', 'company_id']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    // Estoque exato nunca aparece — só available/lowStock (booleanos).
    expect(serialized).not.toContain('"7"')
    expect(result?.variations[0]).toEqual({
      variationId: 10, sku: 'SKU-1', attributes: [], price: 50, available: true, lowStock: false,
    })
  })

  it('produto inativo/inexistente → null', async () => {
    vi.spyOn(mediaService, 'listMediaByEntity').mockResolvedValue({ ok: true, data: [] })
    mockCatalog({ product: null, variations: [] })
    const result = await getWholesaleProductDetail(1, 999)
    expect(result).toBeNull()
  })
})
