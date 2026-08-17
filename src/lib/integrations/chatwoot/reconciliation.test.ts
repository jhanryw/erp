import { describe, it, expect, vi, afterEach } from 'vitest'
import * as adminModule from '@/lib/supabase/admin'
import {
  buildQarvonCustomAttributesPayload,
  mergeChatwootCustomAttributes,
  buildQarvonCategoryAttributesPayload,
  computeCustomerPurchaseProfile,
  type CustomerCommercialAttributes,
  type CustomerPurchaseProfile,
} from './reconciliation'

const fullAttrs: CustomerCommercialAttributes = {
  totalOrders: 4,
  totalSpent: 1299.9,
  averageTicket: 324.98,
  firstPurchaseAt: '2026-01-10',
  lastPurchaseAt: '2026-08-01',
  customerSegment: 'champions',
  cashbackAvailable: 42.5,
}

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

describe('buildQarvonCustomAttributesPayload — namespace qarvon_* (seção 13/47 do pedido)', () => {
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  })

  it('inclui todos os campos quando disponíveis', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://santtorini.qarvon.com'
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect(payload).toEqual({
      qarvon_customer_id: '42',
      qarvon_total_orders: 4,
      qarvon_total_spent: 1299.9,
      qarvon_average_ticket: 324.98,
      qarvon_first_purchase_at: '2026-01-10',
      qarvon_last_purchase_at: '2026-08-01',
      qarvon_customer_segment: 'champions',
      qarvon_cashback_available: 42.5,
      qarvon_erp_link: 'https://santtorini.qarvon.com/clientes/42',
    })
  })

  it('qarvon_cashback_available sempre presente, mesmo zerado (não é "ausência" como average_ticket/datas)', () => {
    const payload = buildQarvonCustomAttributesPayload(42, { ...fullAttrs, cashbackAvailable: 0 })
    expect(payload.qarvon_cashback_available).toBe(0)
  })

  it('qarvon_erp_link usa NEXT_PUBLIC_APP_URL sem barra duplicada', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://santtorini.qarvon.com/'
    const payload = buildQarvonCustomAttributesPayload(275, fullAttrs)
    expect(payload.qarvon_erp_link).toBe('https://santtorini.qarvon.com/clientes/275')
  })

  it('sem NEXT_PUBLIC_APP_URL configurada → omite qarvon_erp_link (nunca link relativo/quebrado — seção 7 do pedido)', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect('qarvon_erp_link' in payload).toBe(false)
  })

  it('qarvon_customer_id é sempre string (tipo texto no Chatwoot, nunca number)', () => {
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect(typeof payload.qarvon_customer_id).toBe('string')
  })

  it('valores monetários são number, nunca string formatada (seção 14 — nunca "R$ 1.299,90")', () => {
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect(typeof payload.qarvon_total_spent).toBe('number')
    expect(typeof payload.qarvon_average_ticket).toBe('number')
  })

  it('datas em formato ISO (YYYY-MM-DD), nunca localizado (seção 15 — nunca "16/08/26")', () => {
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect(payload.qarvon_first_purchase_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(payload.qarvon_last_purchase_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('cliente sem pedidos válidos: omite average_ticket/datas/segmento (nunca envia null)', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const empty: CustomerCommercialAttributes = {
      totalOrders: 0,
      totalSpent: 0,
      averageTicket: null,
      firstPurchaseAt: null,
      lastPurchaseAt: null,
      customerSegment: null,
      cashbackAvailable: 0,
    }
    const payload = buildQarvonCustomAttributesPayload(42, empty)
    expect(payload).toEqual({
      qarvon_customer_id: '42',
      qarvon_total_orders: 0,
      qarvon_total_spent: 0,
      qarvon_cashback_available: 0,
    })
    expect('qarvon_average_ticket' in payload).toBe(false)
    expect('qarvon_first_purchase_at' in payload).toBe(false)
    expect('qarvon_customer_segment' in payload).toBe(false)
  })
})

describe('mergeChatwootCustomAttributes — nunca sobrescreve atributo não-qarvon_* (seção 22/47)', () => {
  it('preserva atributos de outros sistemas/agentes', () => {
    const current = { other_system_field: 'valor humano', crm_note: 'anotado pelo atendente', qarvon_total_orders: 1 }
    const qarvon = { qarvon_total_orders: 5, qarvon_total_spent: 999 }
    const merged = mergeChatwootCustomAttributes(current, qarvon)
    expect(merged.other_system_field).toBe('valor humano')
    expect(merged.crm_note).toBe('anotado pelo atendente')
  })

  it('atualiza só as chaves qarvon_* enviadas', () => {
    const current = { qarvon_total_orders: 1, qarvon_total_spent: 100 }
    const qarvon = { qarvon_total_orders: 5, qarvon_total_spent: 999 }
    const merged = mergeChatwootCustomAttributes(current, qarvon)
    expect(merged.qarvon_total_orders).toBe(5)
    expect(merged.qarvon_total_spent).toBe(999)
  })

  it('contato sem custom_attributes prévios (objeto vazio) funciona normalmente', () => {
    const merged = mergeChatwootCustomAttributes({}, { qarvon_total_orders: 1 })
    expect(merged).toEqual({ qarvon_total_orders: 1 })
  })

  it('sync preserva qarvon_size_* de categorias que não aparecem no payload novo (nunca apaga o que já foi calculado)', () => {
    const current = { qarvon_size_pijama: 'M', qarvon_categories: 'Pijama' }
    const novoPayload = { qarvon_categories: 'Calcinha, Pijama', qarvon_size_calcinha: 'G' }
    const merged = mergeChatwootCustomAttributes(current, novoPayload)
    expect(merged.qarvon_size_pijama).toBe('M')
    expect(merged.qarvon_size_calcinha).toBe('G')
    expect(merged.qarvon_categories).toBe('Calcinha, Pijama')
  })
})

// ─── buildQarvonCategoryAttributesPayload — qarvon_categories + qarvon_size_* ──

describe('buildQarvonCategoryAttributesPayload', () => {
  it('customer sem compras classificáveis → payload vazio (nunca envia qarvon_categories vazio)', () => {
    const profile: CustomerPurchaseProfile = { categories: [], sizesByType: [] }
    expect(buildQarvonCategoryAttributesPayload(profile)).toEqual({})
  })

  it('1 categoria → qarvon_categories com 1 nome', () => {
    const profile: CustomerPurchaseProfile = {
      categories: ['Pijama'],
      sizesByType: [{ productTypeSlug: 'pijama', productTypeName: 'Pijama', totalQuantity: 3, dominantSize: 'M' }],
    }
    const payload = buildQarvonCategoryAttributesPayload(profile)
    expect(payload.qarvon_categories).toBe('Pijama')
    expect(payload.qarvon_size_pijama).toBe('M')
  })

  it('múltiplas categorias → join por vírgula, já deduplicadas e ordenadas por computeCustomerPurchaseProfile', () => {
    const profile: CustomerPurchaseProfile = {
      categories: ['Calcinha', 'Pijama', 'Sutiã'],
      sizesByType: [
        { productTypeSlug: 'calcinha', productTypeName: 'Calcinha', totalQuantity: 5, dominantSize: 'G' },
        { productTypeSlug: 'pijama', productTypeName: 'Pijama', totalQuantity: 2, dominantSize: 'M' },
        { productTypeSlug: 'sutia', productTypeName: 'Sutiã', totalQuantity: 1, dominantSize: null },
      ],
    }
    const payload = buildQarvonCategoryAttributesPayload(profile)
    expect(payload.qarvon_categories).toBe('Calcinha, Pijama, Sutiã')
    expect(payload.qarvon_size_calcinha).toBe('G')
    expect(payload.qarvon_size_pijama).toBe('M')
  })

  it('customer sem tamanho identificável numa categoria → nunca envia qarvon_size_<slug> pra ela (nunca infere sem evidência)', () => {
    const profile: CustomerPurchaseProfile = {
      categories: ['Sutiã'],
      sizesByType: [{ productTypeSlug: 'sutia', productTypeName: 'Sutiã', totalQuantity: 1, dominantSize: null }],
    }
    const payload = buildQarvonCategoryAttributesPayload(profile)
    expect(payload.qarvon_categories).toBe('Sutiã')
    expect('qarvon_size_sutia' in payload).toBe(false)
  })

  it('idempotência: mesma entrada sempre produz o mesmo payload', () => {
    const profile: CustomerPurchaseProfile = {
      categories: ['Pijama'],
      sizesByType: [{ productTypeSlug: 'pijama', productTypeName: 'Pijama', totalQuantity: 3, dominantSize: 'M' }],
    }
    expect(buildQarvonCategoryAttributesPayload(profile)).toEqual(buildQarvonCategoryAttributesPayload(profile))
  })
})

// ─── computeCustomerPurchaseProfile — mapeamento do resultado da RPC ───────────
// A lógica de agregação/desempate/exclusão de venda cancelada é 100% SQL
// (rpc_customer_purchase_profile) — sem acesso a Postgres real neste
// sandbox (mesma limitação de toda a sessão), coberta por
// supabase/tests/customer_purchase_profile.test.sql. Aqui só o mapeamento
// linha-RPC → CustomerPurchaseProfile e a passagem correta de parâmetros
// (isolamento por company_id) são testados.

function mockRpc(data: unknown, error: unknown = null) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data, error }),
  } as any)
}

describe('computeCustomerPurchaseProfile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('customer sem compras (RPC devolve vazio) → categories/sizesByType vazios', async () => {
    mockRpc([])
    const result = await computeCustomerPurchaseProfile(275, 1)
    expect(result).toEqual({ ok: true, data: { categories: [], sizesByType: [] } })
  })

  it('mapeia linhas da RPC pra CustomerPurchaseProfile, ordenando categorias alfabeticamente', async () => {
    mockRpc([
      { product_type_slug: 'sutia', product_type_name: 'Sutiã', total_quantity: 7, dominant_size: 'G' },
      { product_type_slug: 'calcinha', product_type_name: 'Calcinha', total_quantity: 3, dominant_size: 'M' },
    ])
    const result = await computeCustomerPurchaseProfile(275, 1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.categories).toEqual(['Calcinha', 'Sutiã'])
      expect(result.data.sizesByType).toEqual([
        { productTypeSlug: 'sutia', productTypeName: 'Sutiã', totalQuantity: 7, dominantSize: 'G' },
        { productTypeSlug: 'calcinha', productTypeName: 'Calcinha', totalQuantity: 3, dominantSize: 'M' },
      ])
    }
  })

  it('deduplica nomes de categoria repetidos (defesa extra além do GROUP BY da RPC)', async () => {
    mockRpc([
      { product_type_slug: 'pijama', product_type_name: 'Pijama', total_quantity: 2, dominant_size: 'M' },
      { product_type_slug: 'pijama', product_type_name: 'Pijama', total_quantity: 1, dominant_size: 'M' },
    ])
    const result = await computeCustomerPurchaseProfile(275, 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.categories).toEqual(['Pijama'])
  })

  it('isolamento por company_id: passa customer_id e company_id corretos pra RPC', async () => {
    const rpcSpy = vi.fn().mockResolvedValue({ data: [], error: null })
    vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({ rpc: rpcSpy } as any)

    await computeCustomerPurchaseProfile(275, 1)

    expect(rpcSpy).toHaveBeenCalledWith('rpc_customer_purchase_profile', { p_customer_id: 275, p_company_id: 1 })
  })

  it('propaga erro da RPC', async () => {
    mockRpc(null, { message: 'função não existe' })
    const result = await computeCustomerPurchaseProfile(275, 1)
    expect(result.ok).toBe(false)
  })
})
