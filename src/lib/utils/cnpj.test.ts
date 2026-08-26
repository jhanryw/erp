import { describe, it, expect } from 'vitest'
import { validateCNPJ, formatCNPJ, cleanCNPJ } from './cnpj'

describe('validateCNPJ', () => {
  it('aceita um CNPJ válido conhecido', () => {
    expect(validateCNPJ('11.222.333/0001-81')).toBe(true)
    expect(validateCNPJ('11222333000181')).toBe(true)
  })

  it('rejeita todos os dígitos iguais', () => {
    expect(validateCNPJ('11111111111111')).toBe(false)
  })

  it('rejeita tamanho errado', () => {
    expect(validateCNPJ('123')).toBe(false)
    expect(validateCNPJ('112223330001811')).toBe(false)
  })

  it('rejeita dígito verificador incorreto', () => {
    expect(validateCNPJ('11222333000182')).toBe(false)
  })
})

describe('formatCNPJ / cleanCNPJ', () => {
  it('formata e limpa corretamente', () => {
    expect(formatCNPJ('11222333000181')).toBe('11.222.333/0001-81')
    expect(cleanCNPJ('11.222.333/0001-81')).toBe('11222333000181')
  })
})
