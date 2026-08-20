import { describe, it, expect } from 'vitest'
import { normalizeNcm } from './ncmRules'

describe('normalizeNcm', () => {
  it('null → null', () => {
    expect(normalizeNcm(null)).toBeNull()
  })

  it('undefined → null', () => {
    expect(normalizeNcm(undefined)).toBeNull()
  })

  it('string vazia → null', () => {
    expect(normalizeNcm('')).toBeNull()
  })

  it('7 dígitos → null', () => {
    expect(normalizeNcm('6108220')).toBeNull()
  })

  it('9 dígitos → null', () => {
    expect(normalizeNcm('610822001')).toBeNull()
  })

  it('contém letras → null', () => {
    expect(normalizeNcm('6108220A')).toBeNull()
  })

  it('8 dígitos com pontuação ("6108.22.00") → normalizado pra "61082200"', () => {
    expect(normalizeNcm('6108.22.00')).toBe('61082200')
  })

  it('8 dígitos com espaços ("6108 22 00") → normalizado pra "61082200"', () => {
    expect(normalizeNcm('6108 22 00')).toBe('61082200')
  })

  it('8 dígitos sem pontuação → devolve o mesmo valor', () => {
    expect(normalizeNcm('61082200')).toBe('61082200')
  })

  it('nunca lança, mesmo com entrada absurda', () => {
    expect(() => normalizeNcm('!!!@@@###')).not.toThrow()
    expect(normalizeNcm('!!!@@@###')).toBeNull()
  })
})
