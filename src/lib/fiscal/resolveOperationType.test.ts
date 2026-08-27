import { describe, it, expect } from 'vitest'
import { resolveOperationType } from './resolveOperationType'

describe('resolveOperationType — prioridade: wholesale > website > whatsapp > manual > pos(delivery_mode)', () => {
  it('sale_type=wholesale → wholesale, independente de canal/origem', () => {
    expect(resolveOperationType({ saleType: 'wholesale', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: 'pickup' })).toBe('wholesale')
    expect(resolveOperationType({ saleType: 'wholesale', salesChannel: 'wholesale_site', saleOrigin: 'website', deliveryMode: null })).toBe('wholesale')
    expect(resolveOperationType({ saleType: 'wholesale', salesChannel: null, saleOrigin: null, deliveryMode: null })).toBe('wholesale')
  })

  it('sales_channel=nuvemshop → website (mesmo sem sale_origin=website)', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'nuvemshop', saleOrigin: null, deliveryMode: null })).toBe('website')
  })

  it('sale_origin=website → website (venda manual marcada como site, mesmo sem canal nuvemshop)', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'website', deliveryMode: 'pickup' })).toBe('website')
  })

  it('sales_channel=whatsapp → whatsapp', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'whatsapp', saleOrigin: 'other', deliveryMode: null })).toBe('whatsapp')
  })

  it('sales_channel=manual → manual', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'manual', saleOrigin: 'other', deliveryMode: null })).toBe('manual')
  })

  it('sales_channel=pos + delivery_mode=delivery → pos_delivery', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: 'delivery' })).toBe('pos_delivery')
  })

  it('sales_channel=pos + delivery_mode=pickup → pos_pickup', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: 'pickup' })).toBe('pos_pickup')
  })

  it('sales_channel=pos + delivery_mode ausente → pos_retail (balcão sem shipment, legítimo)', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: null })).toBe('pos_retail')
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: undefined })).toBe('pos_retail')
  })

  it('sales_channel ausente (venda antiga, compatibilidade) + delivery_mode ausente → pos_retail', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: null, saleOrigin: 'store', deliveryMode: null })).toBe('pos_retail')
  })

  it('sales_channel=pos + delivery_mode com valor corrompido → null, nunca presume', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: 'algo_invalido' })).toBeNull()
  })

  it('sales_channel fora do conjunto conhecido → null, nunca presume', () => {
    expect(resolveOperationType({ saleType: 'retail', salesChannel: 'canal_desconhecido', saleOrigin: 'other', deliveryMode: null })).toBeNull()
  })

  it('nunca lança, mesmo com entradas absurdas', () => {
    expect(() => resolveOperationType({ saleType: '', salesChannel: '', saleOrigin: '', deliveryMode: '' })).not.toThrow()
  })

  it('site de atacado (sale_type=wholesale + sales_channel=wholesale_site + sale_origin=website) → wholesale, NÃO website', () => {
    // Este é o caso real que motivou a prioridade 1 > 2: o checkout de
    // atacado grava sale_origin='website' (herdando o comportamento fiscal
    // de NF-e) mas a modalidade comercial real é atacado, que tem sua
    // PRÓPRIA política (auto_issue=false por padrão pra Santtorini) —
    // nunca deve cair na política 'website' (auto_issue=true).
    expect(resolveOperationType({ saleType: 'wholesale', salesChannel: 'wholesale_site', saleOrigin: 'website', deliveryMode: null })).toBe('wholesale')
  })
})
