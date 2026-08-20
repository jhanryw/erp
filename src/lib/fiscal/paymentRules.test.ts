import { describe, it, expect } from 'vitest'
import { resolveFormaPagamento, resolveIndicadorPagamento, resolveBandeiraOperadora } from './paymentRules'
import { FiscalRuleNotImplementedError } from './taxRules'

describe('resolveFormaPagamento', () => {
  it('pix → "20" (PIX estático) — confirmado empiricamente pelos 2 XMLs reais autorizados, não "17" (dinâmico)', () => {
    expect(resolveFormaPagamento('pix')).toBe('20')
  })

  it('cash → "01" (Dinheiro)', () => {
    expect(resolveFormaPagamento('cash')).toBe('01')
  })

  it('credit_card → "03"', () => {
    expect(resolveFormaPagamento('credit_card')).toBe('03')
  })

  it('debit_card → "04"', () => {
    expect(resolveFormaPagamento('debit_card')).toBe('04')
  })

  it('"card" (legado) → lança FiscalRuleNotImplementedError, nunca presume crédito ou débito', () => {
    expect(() => resolveFormaPagamento('card')).toThrow(FiscalRuleNotImplementedError)
  })

  it('método desconhecido → lança FiscalRuleNotImplementedError', () => {
    expect(() => resolveFormaPagamento('boleto')).toThrow(FiscalRuleNotImplementedError)
  })
})

describe('resolveIndicadorPagamento', () => {
  it('sempre "0" (à vista) — este ERP não modela pagamento "a prazo" no sentido fiscal', () => {
    expect(resolveIndicadorPagamento()).toBe('0')
  })
})

describe('resolveBandeiraOperadora', () => {
  it('bandeira ausente/vazia → null (campo omitido, nunca inventado)', () => {
    expect(resolveBandeiraOperadora(null)).toBeNull()
    expect(resolveBandeiraOperadora('')).toBeNull()
    expect(resolveBandeiraOperadora('   ')).toBeNull()
  })

  it('bandeiras conhecidas mapeiam pro código correto, case-insensitive e com espaço', () => {
    expect(resolveBandeiraOperadora('visa')).toBe('01')
    expect(resolveBandeiraOperadora('Visa')).toBe('01')
    expect(resolveBandeiraOperadora('  MASTERCARD  ')).toBe('02')
    expect(resolveBandeiraOperadora('elo')).toBe('06')
    expect(resolveBandeiraOperadora('hipercard')).toBe('07')
  })

  it('bandeira presente mas não reconhecida → "99" (Outros), nunca um código específico chutado', () => {
    expect(resolveBandeiraOperadora('bandeira-nova-desconhecida')).toBe('99')
  })
})
