import { describe, it, expect, vi, afterEach } from 'vitest'
import { listFocusEmpresas, consultFocusNfe } from './httpClient'
import { FocusApiError } from './types'

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('httpClient — resolução de base URL por ambiente', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('homologação usa homologacao.focusnfe.com.br', async () => {
    const fetchSpy = mockFetchOnce(200, [])
    vi.stubGlobal('fetch', fetchSpy)

    await listFocusEmpresas({ token: 'tok', environment: 'homologacao' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://homologacao.focusnfe.com.br/v2/empresas',
      expect.any(Object),
    )
  })

  it('produção usa api.focusnfe.com.br', async () => {
    const fetchSpy = mockFetchOnce(200, [])
    vi.stubGlobal('fetch', fetchSpy)

    await listFocusEmpresas({ token: 'tok', environment: 'producao' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.focusnfe.com.br/v2/empresas',
      expect.any(Object),
    )
  })
})

describe('httpClient — Basic Auth (token como usuário, senha vazia)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('envia Authorization: Basic base64(token:) — nunca Bearer, nunca o token em texto puro no header', async () => {
    const fetchSpy = mockFetchOnce(200, [])
    vi.stubGlobal('fetch', fetchSpy)

    await listFocusEmpresas({ token: 'segredo-super-secreto', environment: 'homologacao' })

    const [, init] = fetchSpy.mock.calls[0]
    const authHeader = init.headers.Authorization as string

    expect(authHeader).toMatch(/^Basic /)
    expect(authHeader).not.toContain('segredo-super-secreto')
    expect(Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8')).toBe('segredo-super-secreto:')
  })
})

describe('httpClient — parsing de erro', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('HTTP 422 com {codigo, mensagem} vira FocusApiError com os dois campos preservados', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(422, { codigo: 'erro_validacao_schema', mensagem: 'CNPJ inválido' }))

    await expect(consultFocusNfe('ref-123', { token: 'tok', environment: 'homologacao' })).rejects.toMatchObject({
      httpStatus: 422,
      codigo: 'erro_validacao_schema',
      mensagem: 'CNPJ inválido',
    })
  })

  it('erro é instância de FocusApiError', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { codigo: 'requisicao_invalida', mensagem: 'campo obrigatório ausente' }))

    await expect(consultFocusNfe('ref-123', { token: 'tok', environment: 'homologacao' })).rejects.toBeInstanceOf(FocusApiError)
  })

  it('corpo de erro sem {codigo, mensagem} reconhecíveis não lança exceção não tratada — mensagem cai pro fallback', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(500, 'erro interno inesperado'))

    await expect(consultFocusNfe('ref-123', { token: 'tok', environment: 'homologacao' })).rejects.toThrow(/HTTP 500/)
  })
})

describe('httpClient — timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AbortError vira mensagem de timeout legível, não o AbortError cru', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))

    await expect(consultFocusNfe('ref-123', { token: 'tok', environment: 'homologacao', timeoutMs: 10 })).rejects.toThrow(/tempo limite/)
  })
})
