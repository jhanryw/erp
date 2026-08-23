import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getReceiptByToken, getReceiptForSalePrint, isValidReceiptToken } from './getReceiptData'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const VALID_TOKEN = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

function chainable(result: { data: any; error: any }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    maybeSingle: async () => result,
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

const SALE_ROW = {
  id: 42,
  company_id: 1,
  sale_number: 'SNT-20260823-0007',
  receipt_token: VALID_TOKEN,
  sale_date: '2026-08-23',
  created_at: '2026-08-23T14:30:00Z',
  status: 'paid',
  customer_id: 5,
  payment_method: 'pix',
  subtotal: 88,
  discount_amount: 0,
  surcharge_amount: 8,
  shipping_charged: 12,
  cashback_used: 0,
  total: 100,
}

const BASE_TABLES: Record<string, { data: any; error: any }> = {
  company_fiscal_settings: { data: null, error: null },
  companies: { data: { name: 'Santtorini' }, error: null },
  sale_items: {
    data: [{ id: 501, quantity: 2, unit_price: 45, total_price: 90, product_variation_id: 9 }],
    error: null,
  },
  sale_payments: {
    data: [{ method: 'pix', amount_tendered: 100, change_amount: 0, change_method: null }],
    error: null,
  },
  exchange_items: { data: [], error: null },
  product_variations: { data: [{ id: 9, sku_variation: 'SKU-9', product_id: 3 }], error: null },
  products: { data: [{ id: 3, name: 'Camiseta' }], error: null },
  product_variation_attributes: { data: [], error: null },
  customers: { data: { name: 'Cliente Teste' }, error: null },
}

/** Mock que também valida os filtros aplicados na tabela `sales` — necessário
 * para provar isolamento por company_id (getReceiptForSalePrint). */
function mockAdminWithSalesFilter(saleRow: typeof SALE_ROW | null, expectFilters: Record<string, unknown>) {
  return {
    from: (table: string) => {
      if (table === 'sales') {
        const applied: Record<string, unknown> = {}
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            applied[col] = val
            return chain
          },
          maybeSingle: async () => {
            const matches = Object.entries(expectFilters).every(([k, v]) => applied[k] === v)
            return { data: matches ? saleRow : null, error: null }
          },
        }
        return chain
      }
      return chainable(BASE_TABLES[table] ?? { data: null, error: null })
    },
  }
}

function setupMock(saleRow: typeof SALE_ROW | null = SALE_ROW) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    mockAdminWithSalesFilter(saleRow, { receipt_token: VALID_TOKEN }),
  )
}

describe('isValidReceiptToken', () => {
  it('aceita UUID v4 válido', () => {
    expect(isValidReceiptToken(VALID_TOKEN)).toBe(true)
  })
  it('rejeita string arbitrária (não tenta nem consultar o banco)', () => {
    expect(isValidReceiptToken('nao-e-um-uuid')).toBe(false)
    expect(isValidReceiptToken('42')).toBe(false)
    expect(isValidReceiptToken('')).toBe(false)
  })
})

describe('getReceiptByToken', () => {
  afterEach(() => vi.restoreAllMocks())

  it('token inválido nunca chega a consultar o banco — retorna null direto', async () => {
    const spy = vi.fn()
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(spy)

    const result = await getReceiptByToken('token-invalido')
    expect(result).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('token válido mas sem venda correspondente — retorna null (não expõe nada)', async () => {
    setupMock(null)
    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result).toBeNull()
  })

  it('resolve para a venda correta (id/sale_number batem com o token)', async () => {
    setupMock()
    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result?.sale.id).toBe(42)
    expect(result?.sale.sale_number).toBe('SNT-20260823-0007')
    expect(result?.sale.receipt_token).toBe(VALID_TOKEN)
  })

  it('lista os itens corretos, com o preço efetivamente vendido (não o de tabela)', async () => {
    setupMock()
    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result?.items).toHaveLength(1)
    expect(result?.items[0]).toMatchObject({
      product_name: 'Camiseta',
      quantity: 2,
      unit_price: 45,
      total_price: 90,
    })
  })

  it('nunca inclui dados de cliente na variante pública (token)', async () => {
    setupMock()
    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result?.customer).toBeNull()
  })

  it('quantidade já trocada reduz a elegibilidade', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: (table: string) => {
        if (table === 'sales') return chainable({ data: SALE_ROW, error: null })
        if (table === 'exchange_items') {
          return chainable({ data: [{ sale_item_id: 501, quantity_returned: 1 }], error: null })
        }
        return chainable(BASE_TABLES[table] ?? { data: null, error: null })
      },
    })

    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result?.items[0].already_returned).toBe(1)
    expect(result?.items[0].available_to_return).toBe(1) // quantity=2 - 1
  })

  it('venda cancelada é retornada normalmente (status refletido, não escondida)', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      mockAdminWithSalesFilter({ ...SALE_ROW, status: 'cancelled' }, { receipt_token: VALID_TOKEN }),
    )
    const result = await getReceiptByToken(VALID_TOKEN)
    expect(result?.sale.status).toBe('cancelled')
  })
})

describe('getReceiptForSalePrint — isolamento por empresa', () => {
  afterEach(() => vi.restoreAllMocks())

  it('company_id da sessão bate com o da venda — retorna o comprovante', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      mockAdminWithSalesFilter(SALE_ROW, { id: 42, company_id: 1 }),
    )
    const result = await getReceiptForSalePrint({ saleId: 42, companyId: 1 })
    expect(result?.sale.id).toBe(42)
  })

  it('venda de OUTRA empresa não é exposta — company_id não bate, retorna null', async () => {
    // A venda pertence à empresa 1, mas a sessão que está pedindo é da empresa 2.
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      mockAdminWithSalesFilter(SALE_ROW, { id: 42, company_id: 1 }),
    )
    const result = await getReceiptForSalePrint({ saleId: 42, companyId: 2 })
    expect(result).toBeNull()
  })

  it('inclui nome do cliente na variante interna (autenticada)', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      mockAdminWithSalesFilter(SALE_ROW, { id: 42, company_id: 1 }),
    )
    const result = await getReceiptForSalePrint({ saleId: 42, companyId: 1 })
    expect(result?.customer).toEqual({ name: 'Cliente Teste' })
  })
})
