import { describe, it, expect } from 'vitest'
import { resolveFiscalDocumentType, describeFiscalDocumentTypeBlockReason } from './resolveFiscalDocumentType'

describe('resolveFiscalDocumentType — regra aprovada (prioridade: website > delivery > pickup > store sem shipment > blocked)', () => {
  it('store sem shipment (delivery_mode ausente) → nfce — balcão pode legitimamente não criar shipment', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: null, saleOrigin: 'store' })).toBe('nfce')
    expect(resolveFiscalDocumentType({ deliveryMode: undefined, saleOrigin: 'store' })).toBe('nfce')
  })

  it('pickup (delivery_mode explícito) → nfce', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: 'store' })).toBe('nfce')
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: null })).toBe('nfce')
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: 'instagram' })).toBe('nfce')
  })

  it('delivery (delivery_mode explícito) → nfe', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'store' })).toBe('nfe')
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: null })).toBe('nfe')
  })

  it('website (qualquer delivery_mode, inclusive ausente) → nfe', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: null, saleOrigin: 'website' })).toBe('nfe')
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'website' })).toBe('nfe')
  })

  it('website + pickup → nfe — website prevalece mesmo com retirada explícita (política conservadora)', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'pickup', saleOrigin: 'website' })).toBe('nfe')
  })

  it('store + delivery → nfe — delivery explícito prevalece sobre origem de balcão', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'delivery', saleOrigin: 'store' })).toBe('nfe')
  })

  it('conflito/inconsistência (delivery_mode com valor inesperado) → blocked, nunca presume', () => {
    expect(resolveFiscalDocumentType({ deliveryMode: 'algo_invalido', saleOrigin: 'store' })).toBe('blocked')
    expect(resolveFiscalDocumentType({ deliveryMode: 'algo_invalido', saleOrigin: 'website' } as any)).toBe('nfe') // website ainda prevalece sobre dado inconsistente de delivery_mode
  })

  it('sem delivery_mode E sem origem presencial clara (instagram/referral/paid_traffic/other/null) → blocked', () => {
    for (const origin of ['instagram', 'referral', 'paid_traffic', 'other', null, undefined]) {
      expect(resolveFiscalDocumentType({ deliveryMode: null, saleOrigin: origin })).toBe('blocked')
    }
  })

  it('nunca lança, mesmo com entradas absurdas', () => {
    expect(() => resolveFiscalDocumentType({ deliveryMode: '', saleOrigin: '' })).not.toThrow()
    expect(resolveFiscalDocumentType({ deliveryMode: '', saleOrigin: '' })).toBe('blocked')
  })
})

describe('resolveFiscalDocumentType — regressão venda 636 (achado real, Fase Fiscal 4G)', () => {
  /**
   * Venda 636 real: sale_origin='store', status='paid', shipping_charged=10.00,
   * payment_method='pix', operacionalmente retirada/balcão — SEM nenhuma
   * linha em `shipments` (confirmado: sem FK enforced entre shipments e
   * pedidos, `sale_shipping` sem registro pra essa venda). O input que
   * `vendas/[id]/page.tsx`/`/api/fiscal/nfce/emitir-homologacao` montam
   * pra essa venda é exatamente `{ deliveryMode: null, saleOrigin: 'store' }`
   * — `shippingCharged` NUNCA é um parâmetro desta função (a interface
   * `ResolveFiscalDocumentTypeInput` só tem `deliveryMode`/`saleOrigin` —
   * não há como um valor de frete cobrado vazar pra dentro da decisão,
   * verificado por não existir no tipo).
   */
  it('sale_origin=store, shipping_charged=10, sem delivery_mode confiável (sem shipments) → nfce', () => {
    const venda636Input = { deliveryMode: null, saleOrigin: 'store' }
    expect(resolveFiscalDocumentType(venda636Input)).toBe('nfce')
    expect(describeFiscalDocumentTypeBlockReason(venda636Input)).toBeNull()
  })

  it('shipping_charged nunca é aceito como entrada — TypeScript não permite a propriedade (prova estática, não em runtime)', () => {
    // @ts-expect-error — shippingCharged não existe em ResolveFiscalDocumentTypeInput; se este erro
    // parar de acontecer (ex.: alguém adicionar o campo no futuro), o teste quebra a build.
    const withShipping: Parameters<typeof resolveFiscalDocumentType>[0] = { deliveryMode: null, saleOrigin: 'store', shippingCharged: 10 }
    // Mesmo se alguém passar a propriedade extra (JS não impede em runtime), o resultado não muda.
    expect(resolveFiscalDocumentType(withShipping)).toBe('nfce')
  })
})

describe('describeFiscalDocumentTypeBlockReason — motivo estruturado', () => {
  it('sem delivery_mode e sem origem store → mensagem específica de ausência de dado', () => {
    const reason = describeFiscalDocumentTypeBlockReason({ deliveryMode: null, saleOrigin: 'instagram' })
    expect(reason).toBeTruthy()
    expect(reason).toMatch(/não é possível determinar/)
  })

  it('delivery_mode com valor inesperado → mensagem específica de inconsistência', () => {
    const reason = describeFiscalDocumentTypeBlockReason({ deliveryMode: 'algo_invalido', saleOrigin: 'store' })
    expect(reason).toBeTruthy()
    expect(reason).toContain('algo_invalido')
  })

  it('qualquer caso NÃO bloqueado → null', () => {
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'delivery', saleOrigin: 'store' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'pickup', saleOrigin: 'store' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: null, saleOrigin: 'store' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: null, saleOrigin: 'website' })).toBeNull()
    expect(describeFiscalDocumentTypeBlockReason({ deliveryMode: 'pickup', saleOrigin: 'website' })).toBeNull()
  })

  it('consistente com resolveFiscalDocumentType: motivo não-nulo SEMPRE que a decisão é blocked, e vice-versa', () => {
    const cases: Array<{ deliveryMode: string | null | undefined; saleOrigin: string | null | undefined }> = [
      { deliveryMode: 'delivery', saleOrigin: 'store' },
      { deliveryMode: 'pickup', saleOrigin: 'store' },
      { deliveryMode: 'pickup', saleOrigin: 'website' },
      { deliveryMode: null, saleOrigin: 'store' },
      { deliveryMode: null, saleOrigin: 'website' },
      { deliveryMode: null, saleOrigin: 'instagram' },
      { deliveryMode: undefined, saleOrigin: undefined },
      { deliveryMode: 'invalido', saleOrigin: 'store' },
      { deliveryMode: 'invalido', saleOrigin: 'website' },
    ]
    for (const c of cases) {
      const decision = resolveFiscalDocumentType(c)
      const reason = describeFiscalDocumentTypeBlockReason(c)
      expect(decision === 'blocked').toBe(reason !== null)
    }
  })
})
