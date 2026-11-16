import { describe, it, expect } from 'vitest'
import { formatFocusDateTime, isValidFocusDateTime } from './emissionDate'

describe('formatFocusDateTime', () => {
  it('converte UTC para America/Sao_Paulo com offset -03:00', () => {
    expect(formatFocusDateTime(new Date('2026-11-16T13:05:00Z'))).toBe('2026-11-16T10:05:00-03:00')
  })
  it('vira o dia corretamente (01:30 UTC → 22:30 do dia anterior)', () => {
    expect(formatFocusDateTime(new Date('2026-11-17T01:30:00Z'))).toBe('2026-11-16T22:30:00-03:00')
  })
  it('respeita outros fusos (offset positivo)', () => {
    expect(formatFocusDateTime(new Date('2026-11-16T13:05:00Z'), 'UTC')).toBe('2026-11-16T13:05:00+00:00')
  })
  it('rejeita data inválida', () => {
    expect(() => formatFocusDateTime(new Date('x'))).toThrow()
  })
})

describe('isValidFocusDateTime', () => {
  it('aceita ISO com offset e rejeita vazio/sem fuso/Z', () => {
    expect(isValidFocusDateTime('2026-11-16T10:05:00-03:00')).toBe(true)
    expect(isValidFocusDateTime('')).toBe(false)
    expect(isValidFocusDateTime(undefined)).toBe(false)
    expect(isValidFocusDateTime('2026-11-16T10:05:00')).toBe(false)
    expect(isValidFocusDateTime('2026-11-16 10:05:00-03:00')).toBe(false)
  })
})
