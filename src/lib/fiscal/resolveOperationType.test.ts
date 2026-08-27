import { describe, it, expect } from 'vitest'
import { resolveOperationType } from './resolveOperationType'

describe('resolveOperationType — 4 tipos, prioridade: website > wholesale > retail_delivery > retail_pickup', () => {
  it('sale_origin=website → website, independente de sale_type/delivery_mode', () => {
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'website', deliveryMode: null })).toBe('website')
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'website', deliveryMode: 'pickup' })).toBe('website')
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'website', deliveryMode: 'delivery' })).toBe('website')
  })

  it('venda do SITE DE ATACADO (sale_origin=website + sale_type=wholesale) → website, NÃO wholesale (decisão confirmada nesta revisão)', () => {
    expect(resolveOperationType({ saleType: 'wholesale', saleOrigin: 'website', deliveryMode: null })).toBe('website')
    expect(resolveOperationType({ saleType: 'wholesale', saleOrigin: 'website', deliveryMode: 'delivery' })).toBe('website')
  })

  it('sale_type=wholesale FORA do site → wholesale', () => {
    expect(resolveOperationType({ saleType: 'wholesale', saleOrigin: 'store', deliveryMode: 'pickup' })).toBe('wholesale')
    expect(resolveOperationType({ saleType: 'wholesale', saleOrigin: 'other', deliveryMode: null })).toBe('wholesale')
    expect(resolveOperationType({ saleType: 'wholesale', saleOrigin: null, deliveryMode: 'delivery' })).toBe('wholesale')
  })

  it('varejo com entrega (delivery_mode=delivery, sem website/wholesale) → retail_delivery', () => {
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'store', deliveryMode: 'delivery' })).toBe('retail_delivery')
  })

  it('todo o restante do varejo (pickup, balcão sem shipment, WhatsApp, manual) → retail_pickup', () => {
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'store', deliveryMode: 'pickup' })).toBe('retail_pickup')
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'store', deliveryMode: null })).toBe('retail_pickup')
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'store', deliveryMode: undefined })).toBe('retail_pickup')
    // WhatsApp/manual não são mais checados como canal — caem no fallback de varejo pela ausência de entrega
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'other', deliveryMode: null })).toBe('retail_pickup')
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'instagram', deliveryMode: null })).toBe('retail_pickup')
  })

  it('delivery_mode com valor corrompido (fora de website/wholesale) → null, nunca presume', () => {
    expect(resolveOperationType({ saleType: 'retail', saleOrigin: 'store', deliveryMode: 'algo_invalido' })).toBeNull()
  })

  it('nunca lança, mesmo com entradas absurdas', () => {
    expect(() => resolveOperationType({ saleType: '', saleOrigin: '', deliveryMode: '' })).not.toThrow()
  })
})
