import { describe, it, expect } from 'vitest'
import { classify, normalizeEmailForMatching, type CustomerMatchCandidate } from './customer-identity.service'

describe('classify — hierarquia de confiança (função pura, sem banco)', () => {
  it('CPF válido bate com exatamente 1 customer → EXACT', () => {
    const candidates: CustomerMatchCandidate[] = [{ customerId: 10, matchedBy: 'cpf', value: '11122233344' }]
    expect(classify(candidates)).toEqual({ tier: 'EXACT', candidates: [candidates[0]] })
  })

  it('telefone único na empresa (nenhum CPF disponível) → HIGH_CONFIDENCE', () => {
    const candidates: CustomerMatchCandidate[] = [{ customerId: 20, matchedBy: 'phone', value: '5584999999999' }]
    expect(classify(candidates)).toEqual({ tier: 'HIGH_CONFIDENCE', candidates: [candidates[0]] })
  })

  it('email único na empresa (nenhum CPF/telefone) → HIGH_CONFIDENCE', () => {
    const candidates: CustomerMatchCandidate[] = [{ customerId: 30, matchedBy: 'email', value: 'a@b.com' }]
    expect(classify(candidates)).toEqual({ tier: 'HIGH_CONFIDENCE', candidates: [candidates[0]] })
  })

  it('nenhum sinal bateu → NO_MATCH', () => {
    expect(classify([])).toEqual({ tier: 'NO_MATCH', candidates: [] })
  })

  it('telefone bate com 2 customers diferentes (mesmo tipo de sinal) → AMBIGUOUS', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 1, matchedBy: 'phone', value: '5584999999999' },
      { customerId: 2, matchedBy: 'phone', value: '5584999999999' },
    ]
    const result = classify(candidates)
    expect(result.tier).toBe('AMBIGUOUS')
    expect(result.candidates).toHaveLength(2)
  })

  it('email bate com um customer e telefone aponta pra OUTRO → CONFLICT (tipos diferentes)', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 1, matchedBy: 'email', value: 'a@b.com' },
      { customerId: 2, matchedBy: 'phone', value: '5584999999999' },
    ]
    const result = classify(candidates)
    expect(result.tier).toBe('CONFLICT')
    expect(result.candidates.map((c) => c.customerId).sort()).toEqual([1, 2])
  })

  it('CPF bate com um customer, mas telefone/email apontam pra OUTRO → CONFLICT (CPF nunca é ignorado silenciosamente)', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 1, matchedBy: 'cpf', value: '11122233344' },
      { customerId: 2, matchedBy: 'phone', value: '5584999999999' },
    ]
    const result = classify(candidates)
    expect(result.tier).toBe('CONFLICT')
  })

  it('CPF e telefone concordam no MESMO customer → EXACT (sinais reforçam, não conflitam)', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 1, matchedBy: 'cpf', value: '11122233344' },
      { customerId: 1, matchedBy: 'phone', value: '5584999999999' },
    ]
    const result = classify(candidates)
    expect(result.tier).toBe('EXACT')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].customerId).toBe(1)
  })

  it('telefone e email concordam no mesmo customer (sem CPF) → HIGH_CONFIDENCE, não duplica candidato', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 5, matchedBy: 'phone', value: '5584999999999' },
      { customerId: 5, matchedBy: 'email', value: 'a@b.com' },
    ]
    const result = classify(candidates)
    expect(result.tier).toBe('HIGH_CONFIDENCE')
    expect(result.candidates).toHaveLength(1)
  })

  it('CPF bate com 2 customers diferentes (não deveria acontecer — CPF é único por empresa — mas tratado defensivamente) → AMBIGUOUS', () => {
    const candidates: CustomerMatchCandidate[] = [
      { customerId: 1, matchedBy: 'cpf', value: '11122233344' },
      { customerId: 2, matchedBy: 'cpf', value: '11122233344' },
    ]
    expect(classify(candidates).tier).toBe('AMBIGUOUS')
  })
})

describe('normalizeEmailForMatching — trim + lowercase, sem heurística de provedor', () => {
  it('normaliza maiúsculas e espaços', () => {
    expect(normalizeEmailForMatching('  Fulano@Exemplo.COM  ')).toBe('fulano@exemplo.com')
  })

  it('não remove "+" nem "." do local-part (nunca heurística de Gmail)', () => {
    expect(normalizeEmailForMatching('fulano+promo@exemplo.com')).toBe('fulano+promo@exemplo.com')
    expect(normalizeEmailForMatching('fu.lano@exemplo.com')).toBe('fu.lano@exemplo.com')
  })

  it('null/undefined/vazio → null', () => {
    expect(normalizeEmailForMatching(null)).toBeNull()
    expect(normalizeEmailForMatching(undefined)).toBeNull()
    expect(normalizeEmailForMatching('   ')).toBeNull()
  })
})
