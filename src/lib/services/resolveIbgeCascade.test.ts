import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveIbgeCascade, isValidIbgeFormat } from './resolveIbgeCascade'
import { resolveMunicipioIbge } from '@/services/fiscal/resolveMunicipioIbge'

vi.mock('@/services/fiscal/resolveMunicipioIbge', () => ({ resolveMunicipioIbge: vi.fn() }))

describe('isValidIbgeFormat', () => {
  it('aceita exatamente 7 dígitos numéricos', () => {
    expect(isValidIbgeFormat('2408102')).toBe(true)
  })

  it('rejeita menos ou mais de 7 dígitos', () => {
    expect(isValidIbgeFormat('240810')).toBe(false)
    expect(isValidIbgeFormat('24081022')).toBe(false)
  })

  it('rejeita não-numérico, vazio, null e undefined', () => {
    expect(isValidIbgeFormat('240810A')).toBe(false)
    expect(isValidIbgeFormat('')).toBe(false)
    expect(isValidIbgeFormat(null)).toBe(false)
    expect(isValidIbgeFormat(undefined)).toBe(false)
  })
})

describe('resolveIbgeCascade — ViaCEP primeiro, resolveMunicipioIbge como fallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ViaCEP traz ibge válido → usa direto, NUNCA chama resolveMunicipioIbge', async () => {
    const spy = resolveMunicipioIbge as unknown as ReturnType<typeof vi.fn>

    const result = await resolveIbgeCascade({ viaCepIbge: '2408102', uf: 'RN', municipio: 'Natal' })

    expect(result).toEqual({ codigo: '2408102', source: 'viacep' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('ViaCEP sem ibge (null) → cai para resolveMunicipioIbge (fallback)', async () => {
    const spy = resolveMunicipioIbge as unknown as ReturnType<typeof vi.fn>
    spy.mockResolvedValue('2408102')

    const result = await resolveIbgeCascade({ viaCepIbge: null, uf: 'RN', municipio: 'Natal' })

    expect(result).toEqual({ codigo: '2408102', source: 'resolve_municipio_ibge' })
    expect(spy).toHaveBeenCalledWith('RN', 'Natal')
  })

  it('ViaCEP com ibge em formato inválido (ex.: resposta corrompida) → ignora e cai para o fallback', async () => {
    const spy = resolveMunicipioIbge as unknown as ReturnType<typeof vi.fn>
    spy.mockResolvedValue('2408102')

    const result = await resolveIbgeCascade({ viaCepIbge: '240810', uf: 'RN', municipio: 'Natal' })

    expect(result).toEqual({ codigo: '2408102', source: 'resolve_municipio_ibge' })
    expect(spy).toHaveBeenCalled()
  })

  it('nenhuma camada resolve → { codigo: null, source: null }, nunca inventa/aproxima', async () => {
    const spy = resolveMunicipioIbge as unknown as ReturnType<typeof vi.fn>
    spy.mockResolvedValue(null)

    const result = await resolveIbgeCascade({ viaCepIbge: undefined, uf: 'RN', municipio: 'Cidade Inexistente' })

    expect(result).toEqual({ codigo: null, source: null })
  })

  it('fallback também devolve formato inválido (defensivo, não deveria acontecer) → trata como não resolvido', async () => {
    const spy = resolveMunicipioIbge as unknown as ReturnType<typeof vi.fn>
    spy.mockResolvedValue('abc')

    const result = await resolveIbgeCascade({ viaCepIbge: null, uf: 'RN', municipio: 'Natal' })

    expect(result).toEqual({ codigo: null, source: null })
  })
})
