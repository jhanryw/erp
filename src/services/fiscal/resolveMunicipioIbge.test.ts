import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveMunicipioIbge } from './resolveMunicipioIbge'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function mockAdminClient({ cached, upsertSpy }: { cached: { codigo_ibge: string } | null; upsertSpy?: ReturnType<typeof vi.fn> }) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: cached }),
          }),
        }),
      }),
      upsert: upsertSpy ?? vi.fn().mockResolvedValue({ error: null }),
    }),
  })
}

describe('resolveMunicipioIbge — nunca lista de cidades hardcoded, sempre cache + API pública do IBGE', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uf ou município ausente → null, sem chamar rede nem banco', async () => {
    const adminSpy = createAdminClient as unknown as ReturnType<typeof vi.fn>
    expect(await resolveMunicipioIbge(null, 'Natal')).toBeNull()
    expect(await resolveMunicipioIbge('RN', null)).toBeNull()
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('cache hit → devolve o código cacheado, nunca chama a API do IBGE', async () => {
    mockAdminClient({ cached: { codigo_ibge: '2408102' } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await resolveMunicipioIbge('RN', 'Natal')
    expect(result).toBe('2408102')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('cache miss → busca na API pública do IBGE, encontra por nome normalizado, cacheia e devolve', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    mockAdminClient({ cached: null, upsertSpy })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 2408102, nome: 'Natal' },
          { id: 2400109, nome: 'Açu' },
        ],
      }),
    )

    const result = await resolveMunicipioIbge('RN', 'Natal')
    expect(result).toBe('2408102')
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codigo_ibge: '2408102', uf: 'RN', nome_normalizado: 'natal' }),
      expect.anything(),
    )
  })

  it('cache miss, nome com acento diferente do IBGE → ainda casa via normalização', async () => {
    mockAdminClient({ cached: null })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 3304557, nome: 'Rio de Janeiro' }],
      }),
    )

    expect(await resolveMunicipioIbge('RJ', '  rio de janeiro  ')).toBe('3304557')
  })

  it('API do IBGE indisponível (erro de rede) → null, nunca lança', async () => {
    mockAdminClient({ cached: null })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    await expect(resolveMunicipioIbge('RN', 'Natal')).resolves.toBeNull()
  })

  it('município sem correspondência na lista da UF → null', async () => {
    mockAdminClient({ cached: null })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 2408102, nome: 'Natal' }] }),
    )

    expect(await resolveMunicipioIbge('RN', 'Cidade Que Não Existe')).toBeNull()
  })

  it('resposta HTTP não-ok da API do IBGE → null, nunca lança', async () => {
    mockAdminClient({ cached: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))

    expect(await resolveMunicipioIbge('RN', 'Natal')).toBeNull()
  })

  it('timeout (AbortError) → null, nunca lança', async () => {
    mockAdminClient({ cached: null })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')))

    await expect(resolveMunicipioIbge('RN', 'Natal')).resolves.toBeNull()
  })

  it('municípios homônimos em UFs diferentes: mesma cidade "São José" em RN e SC resolve pra códigos DIFERENTES, escopado por UF — nunca vaza cache entre estados', async () => {
    const calls: Array<{ uf: string; nome: string }> = []

    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: (_col: string, uf: string) => ({
            eq: (_col2: string, nome: string) => {
              calls.push({ uf, nome })
              return { maybeSingle: async () => ({ data: null }) } // cache sempre miss neste teste
            },
          }),
        }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
      }),
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/estados/RN/')) return { ok: true, json: async () => [{ id: 2412658, nome: 'São José do Campestre' }, { id: 2400000, nome: 'São José' }] }
      if (url.includes('/estados/SC/')) return { ok: true, json: async () => [{ id: 4216602, nome: 'São José' }] }
      return { ok: true, json: async () => [] }
    }))

    const codigoRN = await resolveMunicipioIbge('RN', 'São José')
    const codigoSC = await resolveMunicipioIbge('SC', 'São José')

    expect(codigoRN).toBe('2400000')
    expect(codigoSC).toBe('4216602')
    expect(codigoRN).not.toBe(codigoSC)

    // Confirma que a busca no cache foi escopada por UF corretamente (RN e SC nunca colidem).
    expect(calls).toContainEqual({ uf: 'RN', nome: 'sao jose' })
    expect(calls).toContainEqual({ uf: 'SC', nome: 'sao jose' })
  })
})
