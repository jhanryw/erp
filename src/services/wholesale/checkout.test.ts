import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkoutWholesaleCart } from './checkout'
import { createAdminClient } from '@/lib/supabase/admin'
import { createSale } from '@/services/vendas.service'
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey } from './checkoutIdempotency'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/vendas.service', () => ({ createSale: vi.fn() }))
vi.mock('./checkoutIdempotency', () => ({
  claimIdempotencyKey: vi.fn(),
  completeIdempotencyKey: vi.fn(),
  failIdempotencyKey: vi.fn(),
}))

const BASE_INPUT = {
  customerId: 1,
  companyId: 1,
  systemUserId: 'sys-user-1',
  idempotencyKey: 'key-1',
  deliveryMode: 'pickup' as const,
}

interface Fixture {
  variations?: any[]
  stock?: any[]
  shipmentInsertSpy?: ReturnType<typeof vi.fn>
}

function mockTables({ variations = [], stock = [], shipmentInsertSpy = vi.fn(async () => ({ error: null })) }: Fixture = {}) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'product_variations') return { select: () => ({ in: async () => ({ data: variations, error: null }) }) }
      if (table === 'stock_balances') return { select: () => ({ in: () => ({ eq: () => ({ eq: async () => ({ data: stock, error: null }) }) }) }) }
      if (table === 'shipments') return { insert: shipmentInsertSpy }
      if (table === 'sales') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
      throw new Error(`unexpected table ${table}`)
    },
  })
}

function variationFixture(overrides: Partial<any> = {}) {
  return {
    id: 10, active: true, sku_variation: 'SKU-1', wholesale_price_override: null, cost_override: null, product_id: 1,
    products: { id: 1, company_id: 1, active: true, wholesale_price: 50, base_cost: 20 },
    ...overrides,
  }
}

describe('checkoutWholesaleCart', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('32. carrinho vazio → erro, nunca chama createSale', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [] })
    expect(result.ok).toBe(false)
    expect(createSale).not.toHaveBeenCalled()
  })

  it('34. quantidade zero/negativa → erro, nunca chama createSale', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 0 }] })
    expect(result.ok).toBe(false)
    expect(createSale).not.toHaveBeenCalled()
  })

  it('9/24. preço é SEMPRE recarregado do banco — mesmo se o input tivesse um campo de preço, o tipo não permite, e o valor usado vem de product_variations/products', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createSale as any).mockResolvedValue({ ok: true, data: { id: 999, sale_number: 'W-1' } })
    mockTables({
      variations: [variationFixture({ wholesale_price_override: 45 })],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 2 }] })
    const callArgs = (createSale as any).mock.calls[0][0]
    expect(callArgs.items[0].unit_price).toBe(45) // override da variação, nunca o que um cliente poderia ter mandado
    expect(callArgs.items[0].unit_cost).toBe(20) // base_cost, resolvido no servidor
  })

  it('10. produto sem preço de atacado → item marcado unavailable, venda NUNCA criada', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    mockTables({
      variations: [variationFixture({ products: { id: 1, company_id: 1, active: true, wholesale_price: null, base_cost: 20 } })],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.unavailableItems?.[0].reason).toBe('no_wholesale_price')
    expect(createSale).not.toHaveBeenCalled()
  })

  it('16/38. estoque insuficiente → item marcado insufficient_stock com available real, venda NUNCA criada (não fica negativo)', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    mockTables({
      variations: [variationFixture()],
      stock: [{ product_variation_id: 10, quantity: 1 }],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 2 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.unavailableItems).toEqual([{ variationId: 10, reason: 'insufficient_stock', requested: 2, available: 1 }])
    expect(createSale).not.toHaveBeenCalled()
  })

  it('35. variação de outra empresa → tratada como not_found, nunca vazam dados de outro tenant', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    mockTables({
      variations: [variationFixture({ products: { id: 1, company_id: 999, active: true, wholesale_price: 50, base_cost: 20 } })],
      stock: [],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.unavailableItems?.[0].reason).toBe('not_found')
  })

  it('4. variação inativa não pode ser comprada', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    mockTables({
      variations: [variationFixture({ active: false })],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.unavailableItems?.[0].reason).toBe('inactive')
  })

  it('18/19. sale_type/sales_channel/sale_origin fixados no servidor, sem vendedor humano', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createSale as any).mockResolvedValue({ ok: true, data: { id: 999, sale_number: 'W-1' } })
    mockTables({
      variations: [variationFixture()],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    const callArgs = (createSale as any).mock.calls[0][0]
    expect(callArgs.sale_type).toBe('wholesale')
    expect(callArgs.sales_channel).toBe('wholesale_site')
    expect(callArgs.sale_origin).toBe('website')
    expect(callArgs.responsible_seller_id).toBeNull()
    expect(callArgs.stockMode).toBe('online_priority')
  })

  it('26. snapshot de preço vai para sale_items via createSale (não recalculado depois)', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createSale as any).mockResolvedValue({ ok: true, data: { id: 999, sale_number: 'W-1' } })
    mockTables({
      variations: [variationFixture()],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 3 }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.total).toBe(150) // 50 * 3
  })

  it('36. já processando (claim concorrente) → nunca chama createSale', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'already_processing' })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    expect(createSale).not.toHaveBeenCalled()
  })

  it('36. replay idempotente (já concluído) → devolve o resultado existente, nunca chama createSale de novo', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'already_completed', saleId: 777 })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: (table: string) => {
        if (table === 'sales') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 777, sale_number: 'W-777', total: 300 }, error: null }) }) }) }
        throw new Error(`unexpected table ${table}`)
      },
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result).toEqual({ ok: true, saleId: 777, saleNumber: 'W-777', total: 300 })
    expect(createSale).not.toHaveBeenCalled()
  })

  it('falha em createSale → idempotência marcada como failed, erro repassado', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createSale as any).mockResolvedValue({ ok: false, error: 'Estoque insuficiente no momento da RPC', status: 400 })
    mockTables({
      variations: [variationFixture()],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    expect(failIdempotencyKey).toHaveBeenCalled()
  })

  it('Fase 9 hardening: exceção inesperada nunca vaza mensagem técnica crua pro chamador público', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => { throw new Error('relation "product_variations" violates constraint xyz_internal_detail') },
    })
    const result = await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('xyz_internal_detail')
      expect(result.error).not.toContain('constraint')
    }
    // O detalhe técnico real ainda é preservado (só não vaza pro cliente) — vai pra idempotência, nunca pra resposta HTTP.
    expect(failIdempotencyKey).toHaveBeenCalledWith('key-1', expect.stringContaining('xyz_internal_detail'))
  })

  it('sucesso → completeIdempotencyKey chamado com o sale_id real', async () => {
    ;(claimIdempotencyKey as any).mockResolvedValue({ decision: 'claimed' })
    ;(createSale as any).mockResolvedValue({ ok: true, data: { id: 999, sale_number: 'W-1' } })
    mockTables({
      variations: [variationFixture()],
      stock: [{ product_variation_id: 10, quantity: 5 }],
    })
    await checkoutWholesaleCart({ ...BASE_INPUT, items: [{ variationId: 10, quantity: 1 }] })
    expect(completeIdempotencyKey).toHaveBeenCalledWith('key-1', 999)
  })
})
