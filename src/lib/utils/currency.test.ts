import { describe, it, expect } from 'vitest'
import { parseMoneyInput } from './currency'

describe('parseMoneyInput', () => {
  it.each([
    ['12,90', 12.9],
    ['12.90', 12.9],
    ['10', 10],
    [' 1.234,56 ', 1234.56],
    ['R$ 12,90', 12.9],
    ['0,01', 0.01],
    ['1.234', 1234],
  ])('%j → %s', (raw, expected) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: true, value: expected })
  })

  it.each(['', '   ', null, undefined])('%j → vazio (null, sem erro)', (raw) => {
    expect(parseMoneyInput(raw as string | null | undefined)).toEqual({ ok: true, value: null })
  })

  it.each(['0', '0,00', '0.00'])('%j → erro (precisa ser > 0)', (raw) => {
    const r = parseMoneyInput(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/maior que zero/)
  })

  it.each(['abc', '-5', '12,345', '12.345.6', '1,2,3', 'Infinity', 'NaN', '1e5', '12..9'])('%j → erro (formato inválido)', (raw) => {
    const r = parseMoneyInput(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/inválido/)
  })

  it('nunca devolve NaN/Infinity', () => {
    for (const raw of ['abc', '12,90', '', '0', '9'.repeat(400)]) {
      const r = parseMoneyInput(raw)
      if (r.ok && r.value !== null) expect(Number.isFinite(r.value)).toBe(true)
    }
  })
})
