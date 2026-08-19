import { describe, it, expect } from 'vitest'
import { normalizeMunicipioName } from './normalizeMunicipioName'

describe('normalizeMunicipioName', () => {
  it('remove acentos', () => {
    expect(normalizeMunicipioName('São Paulo')).toBe('sao paulo')
  })

  it('minúsculo', () => {
    expect(normalizeMunicipioName('NATAL')).toBe('natal')
  })

  it('remove espaços duplicados e aparados', () => {
    expect(normalizeMunicipioName('  Rio   de Janeiro  ')).toBe('rio de janeiro')
  })

  it('nomes compostos com acento e cedilha', () => {
    expect(normalizeMunicipioName('Conceição do Araguaia')).toBe('conceicao do araguaia')
  })

  it('duas strings equivalentes só na acentuação normalizam pro mesmo valor', () => {
    expect(normalizeMunicipioName('Marmeleiro')).toBe(normalizeMunicipioName('Marmeleiro'))
    expect(normalizeMunicipioName('São José')).toBe(normalizeMunicipioName('Sao Jose'))
  })
})
