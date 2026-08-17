import { describe, it, expect } from 'vitest'
import { normalizePhoneBR, normalizeE164BR } from './phone'

describe('normalizePhoneBR — casos válidos (todos devem convergir para o mesmo E.164)', () => {
  const expected = '+5584999999999'

  it.each([
    ['(84) 99999-9999', '(84) 99999-9999'],
    ['84 99999-9999', '84 99999-9999'],
    ['84999999999', '84999999999'],
    ['5584999999999', '5584999999999'],
    ['+5584999999999', '+5584999999999'],
    ['005584999999999', '005584999999999'],
  ])('%s → %s', (input) => {
    const result = normalizePhoneBR(input)
    expect(result).toEqual({ ok: true, e164: expected })
  })

  it('celular com espaços extras e pontuação variada', () => {
    expect(normalizePhoneBR('  +55 (84) 99999-9999  ')).toEqual({ ok: true, e164: expected })
  })

  it('fixo — 8 dígitos após o DDD, sem DDI', () => {
    expect(normalizePhoneBR('8433334444')).toEqual({ ok: true, e164: '+558433334444' })
  })

  it('fixo — 8 dígitos após o DDD, com DDI', () => {
    expect(normalizePhoneBR('558433334444')).toEqual({ ok: true, e164: '+558433334444' })
  })

  it('DDD 55 (Rio Grande do Sul) — regressão do bug original (startsWith("55"))', () => {
    // Antes: "55991234567" batia em startsWith('55') e era devolvido sem DDI
    // (11 dígitos, errado). Agora: comprimento 11 → sempre trata como
    // nacional sem DDI, DDD=55 é válido (RS), celular começa com 9.
    expect(normalizePhoneBR('55991234567')).toEqual({ ok: true, e164: '+5555991234567' })
  })

  it('DDD 55 com DDI explícito — 13 dígitos, já correto', () => {
    expect(normalizePhoneBR('+5555991234567')).toEqual({ ok: true, e164: '+5555991234567' })
  })
})

describe('normalizePhoneBR — casos inválidos/ambíguos (nunca adivinha)', () => {
  it('string vazia → empty', () => {
    expect(normalizePhoneBR('')).toEqual({ ok: false, reason: 'empty' })
  })

  it('só espaços → empty', () => {
    expect(normalizePhoneBR('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('null → empty', () => {
    expect(normalizePhoneBR(null)).toEqual({ ok: false, reason: 'empty' })
  })

  it('undefined → empty', () => {
    expect(normalizePhoneBR(undefined)).toEqual({ ok: false, reason: 'empty' })
  })

  it('só letras (nenhum dígito) → empty', () => {
    expect(normalizePhoneBR('não tenho telefone')).toEqual({ ok: false, reason: 'empty' })
  })

  it('número sem DDD (9 dígitos) → invalid_length, nunca inventa DDD', () => {
    expect(normalizePhoneBR('99999-9999')).toEqual({ ok: false, reason: 'invalid_length' })
  })

  it('número curto → invalid_length', () => {
    expect(normalizePhoneBR('12345')).toEqual({ ok: false, reason: 'invalid_length' })
  })

  it('"0" + DDD + número (trunk prefix ambíguo, não é "00" internacional) → invalid_length', () => {
    expect(normalizePhoneBR('084999999999')).toEqual({ ok: false, reason: 'invalid_length' })
  })

  it('DDD começando em 0 → invalid_ddd', () => {
    // 10 dígitos, DDD="05" (inexistente) + 8 dígitos
    expect(normalizePhoneBR('0533334444')).toEqual({ ok: false, reason: 'invalid_ddd' })
  })

  it('celular de 9 dígitos que não começa com 9 → ambiguous', () => {
    expect(normalizePhoneBR('84812345678')).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('múltiplos telefones no mesmo campo → invalid_length (concatenação não bate em nenhum comprimento válido)', () => {
    expect(normalizePhoneBR('84999999999 e 84888888888')).toEqual({ ok: false, reason: 'invalid_length' })
  })

  it('12 dígitos que não começam com 55 → invalid_length', () => {
    expect(normalizePhoneBR('123456789012')).toEqual({ ok: false, reason: 'invalid_length' })
  })

  it('letras misturadas com um número válido extraem só os dígitos (comportamento do replace global, documentado)', () => {
    expect(normalizePhoneBR('84999999999 (celular)')).toEqual({ ok: true, e164: '+5584999999999' })
  })
})

describe('normalizeE164BR — contrato antigo preservado (sem "+", string vazia em falha)', () => {
  it('caso válido retorna sem o "+"', () => {
    expect(normalizeE164BR('84999999999')).toBe('5584999999999')
  })

  it('caso inválido retorna string vazia', () => {
    expect(normalizeE164BR('123')).toBe('')
  })

  it('DDD 55 — mesma regressão coberta acima, mas pelo contrato antigo', () => {
    expect(normalizeE164BR('55991234567')).toBe('5555991234567')
  })
})
