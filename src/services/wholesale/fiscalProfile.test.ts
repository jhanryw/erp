import { describe, it, expect, vi, beforeEach } from 'vitest'

const eq = vi.fn()
const from = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/wholesale/ttlCache', async () => {
  const store = new Map<string, Promise<unknown>>()
  return { cachedForCompany: (c: number, k: string, l: () => Promise<unknown>) => { const key = `${c}:${k}`; if (!store.has(key)) store.set(key, l()); return store.get(key) } }
})
import { getFiscalProfile } from './fiscalProfile'

const row = (cnpj: string) => ({ cnpj, razao_social: 'X LTDA', nome_fantasia: 'X', logradouro: 'Rua', numero_endereco: '1', complemento: null, bairro: 'B', municipio: 'Natal', uf: 'rn' })

describe('getFiscalProfile — isolamento por tenant', () => {
  beforeEach(() => {
    eq.mockReset(); from.mockReset()
    from.mockReturnValue({ select: () => ({ eq: (col: string, v: number) => { eq(col, v); return { maybeSingle: async () => ({ data: row(v === 1 ? '11222333000181' : '99888777000166'), error: null }) } } }) })
  })

  it('filtra sempre por company_id e não mistura empresas no cache', async () => {
    const a = await getFiscalProfile(101)
    const b = await getFiscalProfile(102)
    expect(eq).toHaveBeenCalledWith('company_id', 101)
    expect(eq).toHaveBeenCalledWith('company_id', 102)
    expect(a.uf).toBe('RN')
    expect(eq).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })

  it('erro ou ausência → perfil vazio (nunca outro tenant)', async () => {
    from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'x' } }) }) }) })
    const p = await getFiscalProfile(777)
    expect(p.cnpj).toBe('')
  })
})
