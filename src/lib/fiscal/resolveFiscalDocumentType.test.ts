import { describe, it, expect } from 'vitest'
import { resolveFiscalDocumentType, describeFiscalDocumentTypeBlockReason } from './resolveFiscalDocumentType'

describe('resolveFiscalDocumentType — regra aprovada (Fase Fiscal 4)', () => {
  it('delivery (qualquer origem) → nfe', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'store' })).toBe('nfe')
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'website' })).toBe('nfe')
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'instagram' })).toBe('nfe')
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: null })).toBe('nfe')
  })

  it('pickup + origem store (PDV/balcão) → nfce', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: 'store' })).toBe('nfce')
  })

  it('pickup + origem manual não-website (instagram/referral/paid_traffic/other) → nfce', () => {
    for (const origin of ['instagram', 'referral', 'paid_traffic', 'other']) {
      expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: origin })).toBe('nfce')
    }
  })

  it('pickup + origem website → nfe (política conservadora do ERP, não regra fiscal universal)', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: 'website' })).toBe('nfe')
  })

  it('deliveryMode ausente (null) → blocked, nunca presume', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: null, saleOrigin: 'store' })).toBe('blocked')
  })

  it('deliveryMode undefined → blocked', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: undefined, saleOrigin: 'store' })).toBe('blocked')
  })

  it('deliveryMode com valor inesperado (dado inconsistente) → blocked, nunca presume', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'algo_invalido', saleOrigin: 'store' })).toBe('blocked')
  })

  it('pickup sem saleOrigin (null) → nfce (ausência de origem não é "website", cai no caminho presencial padrão)', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: null })).toBe('nfce')
  })

  it('nunca lança, mesmo com entradas absurdas', () => {
    expect(() => resolveFiscalDocumentType({ deliveryMode: '', saleOrigin: '' })).not.toThrow()
    expect(resolveFiscalDocumentType({ deliveryMode: '', saleOrigin: '' })).toBe('blocked')
  })
})

describe('describeFiscalDocumentTypeBlockReason — motivo estruturado (Fase Fiscal 4F)', () => {
  it('deliveryMode ausente → devolve mensagem explicando o motivo', () => {
    const reason = describeFiscalDocumentTypeBlockReason({ deliveryMode: null, saleOrigin: 'store' })
    expect(reason).toBeTruthy()
    expect(typeof reason).toBe('string')
  })

  it('deliveryMode inválido → devolve mensagem', () => {
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'algo_invalido', saleOrigin: 'store' })).toBeTruthy()
  })

  it('deliveryMode válido (delivery ou pickup) → null, nunca teria bloqueado', () => {
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'delivery', saleOrigin: 'store' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'pickup', saleOrigin: 'store' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'pickup', saleOrigin: 'website' })).toBeNull()
  })

  it('consistente com resolveFiscalDocumentType: motivo não-nulo SEMPRE que a decisão é blocked, e vice-versa', () => {
    const cases: Array<{ deliveryMode: string | null | undefined; saleOrigin: string | null }> = [
      { deliveryMode: 'delivery', saleOrigin: 'store' },
      { deliveryMode: 'pickup', saleOrigin: 'store' },
      { deliveryMode: 'pickup', saleOrigin: 'website' },
      { deliveryMode: null, saleOrigin: 'store' },
      { deliveryMode: undefined, saleOrigin: 'store' },
      { deliveryMode: 'invalido', saleOrigin: 'store' },
    ]
    for (const c of cases) {
      const decision = resolveFiscalDocumentType(c)
      const reason = describeFiscalDocumentTypeBlockReason(c)
      expect(decision === 'blocked').toBe(reason !== null)
    }
  })
})
