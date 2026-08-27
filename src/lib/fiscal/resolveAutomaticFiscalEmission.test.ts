import { describe, it, expect } from 'vitest'
import { resolveAutomaticFiscalEmission } from './resolveAutomaticFiscalEmission'

describe('resolveAutomaticFiscalEmission — automatismo do PDV (Fase Fiscal 7)', () => {
  describe('operatorChoice=none — override explícito, nunca emite nada', () => {
    it('nunca tenta e nunca reporta motivo, mesmo numa venda elegível', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'none',
      })
      expect(result).toEqual({ attempt: null, skipReason: null })
    })

    it('também vale pra venda de atacado (não é o skipReason de atacado, é silêncio puro)', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: null, saleOrigin: 'store', saleType: 'wholesale', operatorChoice: 'none',
      })
      expect(result).toEqual({ attempt: null, skipReason: null })
    })
  })

  describe('operatorChoice=nfe — sempre permitido, nunca tem gate de elegibilidade nem de atacado', () => {
    it('venda comum de balcão (resolveria pra nfce) — nfe explícito ainda é atendido', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'nfe',
      })).toEqual({ attempt: 'nfe', skipReason: null })
    })

    it('venda de atacado — nfe explícito é o único jeito de emitir, e funciona', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'wholesale', operatorChoice: 'nfe',
      })).toEqual({ attempt: 'nfe', skipReason: null })
    })
  })

  describe('atacado (sale_type=wholesale) — exceção legal: NFC-e nunca automática, nem por pedido explícito', () => {
    it('operatorChoice=auto numa venda de atacado elegível pra nfce → bloqueado com motivo', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'wholesale', operatorChoice: 'auto',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toMatch(/atacado/i)
      expect(result.skipReason).toMatch(/crédito fiscal/i)
    })

    it('operatorChoice=nfce explícito numa venda de atacado → também bloqueado (não emite nfce mesmo forçado)', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'wholesale', operatorChoice: 'nfce',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toMatch(/atacado/i)
    })

    it('atacado + delivery (resolveria pra nfe de qualquer forma) — auto ainda funciona, gate de atacado só bloqueia nfce', () => {
      // Nota: o gate de atacado roda ANTES de resolver o tipo — mesmo numa
      // venda de atacado que teria virado nfe naturalmente (entrega), o
      // caminho 'auto' não passa por ali; só operatorChoice='nfe' explícito
      // emite. Documenta o comportamento real, não um "seria bom se".
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: 'delivery', saleOrigin: 'store', saleType: 'wholesale', operatorChoice: 'auto',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toMatch(/atacado/i)
    })
  })

  describe('operatorChoice=auto — venda comum do ERP, emissão automática (seção 4 do pedido)', () => {
    it('balcão/retirada (retail) → tenta nfce automaticamente', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'auto',
      })).toEqual({ attempt: 'nfce', skipReason: null })

      expect(resolveAutomaticFiscalEmission({
        deliveryMode: null, saleOrigin: 'store', saleType: 'retail', operatorChoice: 'auto',
      })).toEqual({ attempt: 'nfce', skipReason: null })
    })

    it('entrega (retail) → tenta nfe automaticamente', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: 'delivery', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'auto',
      })).toEqual({ attempt: 'nfe', skipReason: null })
    })

    it('site (retail) → tenta nfe automaticamente (nunca vira nfce por engano — seção 32 do pedido)', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: null, saleOrigin: 'website', saleType: 'retail', operatorChoice: 'auto',
      })).toEqual({ attempt: 'nfe', skipReason: null })
    })

    it('dado ambíguo (resolveFiscalDocumentType=blocked) → não tenta nada, mas reporta motivo', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: null, saleOrigin: 'instagram', saleType: 'retail', operatorChoice: 'auto',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toBeTruthy()
    })
  })

  describe('operatorChoice=nfce explícito (retail) — mesmo gate de elegibilidade de sempre, nunca troca de tipo silenciosamente', () => {
    it('venda elegível pra nfce → emite', () => {
      expect(resolveAutomaticFiscalEmission({
        deliveryMode: 'pickup', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'nfce',
      })).toEqual({ attempt: 'nfce', skipReason: null })
    })

    it('venda que resolve pra nfe (entrega) mas operador pediu nfce → bloqueado, motivo explica', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: 'delivery', saleOrigin: 'store', saleType: 'retail', operatorChoice: 'nfce',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toMatch(/NF-e/)
    })

    it('venda que resolve pra blocked mas operador pediu nfce → bloqueado, motivo vem de describeFiscalDocumentTypeBlockReason', () => {
      const result = resolveAutomaticFiscalEmission({
        deliveryMode: null, saleOrigin: 'other', saleType: 'retail', operatorChoice: 'nfce',
      })
      expect(result.attempt).toBeNull()
      expect(result.skipReason).toMatch(/não é possível determinar/)
    })
  })
})
