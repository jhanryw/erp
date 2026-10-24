import { describe, it, expect } from 'vitest'
import { ncmFieldSchema, origemFieldSchema } from './index'

describe('ncmFieldSchema / origemFieldSchema (validação do servidor)', () => {
  const ncm = ncmFieldSchema('inválido')
  const origem = origemFieldSchema()
  it('NCM: preserva zero à esquerda e normaliza pontuação', () => {
    expect(ncm.parse('09012100')).toBe('09012100')
    expect(ncm.parse('0901.21.00')).toBe('09012100')
  })
  it('NCM: vazio/ausente vira null/undefined; inválido é rejeitado', () => {
    expect(ncm.parse('')).toBeNull()
    expect(ncm.parse(undefined)).toBeNull()
    expect(ncm.safeParse('1234567').success).toBe(false)
    expect(ncm.safeParse('abcdefgh').success).toBe(false)
  })
  it('origem: 0 é válido e preservado; 9 e fracionário são rejeitados', () => {
    expect(origem.parse(0)).toBe(0)
    expect(origem.parse('0')).toBe(0)
    expect(origem.parse('')).toBeNull()
    expect(origem.safeParse(9).success).toBe(false)
    expect(origem.safeParse(1.5).success).toBe(false)
  })
})
