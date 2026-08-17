import { describe, it, expect } from 'vitest'
import { buildQarvonCustomAttributesPayload, mergeChatwootCustomAttributes, type CustomerCommercialAttributes } from './reconciliation'

const fullAttrs: CustomerCommercialAttributes = {
  totalOrders: 4,
  totalSpent: 1299.9,
  averageTicket: 324.98,
  firstPurchaseAt: '2026-01-10',
  lastPurchaseAt: '2026-08-01',
  customerSegment: 'champions',
}

describe('buildQarvonCustomAttributesPayload — namespace qarvon_* (seção 13/47 do pedido)', () => {
  it('inclui todos os campos quando disponíveis', () => {
    const payload = buildQarvonCustomAttributesPayload(42, fullAttrs)
    expect(payload).toEqual({
      qarvon_customer_id: '42',
      qarvon_total_orders: 4,
      qarvon_total_spent: 1299.9,
      qarvon_average_ticket: 324.98,
      qarvon_first_purchase_at: '2026-01-10',
      qarvon_last_purchase_at: '2026-08-01',
      qarvon_customer_segment: 'champions',
    })
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
    const empty: CustomerCommercialAttributes = {
      totalOrders: 0,
      totalSpent: 0,
      averageTicket: null,
      firstPurchaseAt: null,
      lastPurchaseAt: null,
      customerSegment: null,
    }
    const payload = buildQarvonCustomAttributesPayload(42, empty)
    expect(payload).toEqual({
      qarvon_customer_id: '42',
      qarvon_total_orders: 0,
      qarvon_total_spent: 0,
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
})
