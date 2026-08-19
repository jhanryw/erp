import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncFocusEmpresa } from './focusEmpresa.service'
import * as resolveModule from './resolveFocusIntegration'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPLETE_SETTINGS = {
  cnpj: '11222333000181',
  razao_social: 'Empresa Teste LTDA',
  nome_fantasia: 'Teste',
  inscricao_estadual: '203456789',
  crt: 4,
  logradouro: 'Rua X',
  numero_endereco: '100',
  complemento: null,
  bairro: 'Centro',
  municipio: 'Natal',
  uf: 'RN',
  cep: '59000000',
  telefone: '8499990000',
  email: 'teste@example.com',
}

function mockSettingsRow(row: Record<string, unknown> | null) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  })
}

function mockAvailableIntegration() {
  vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
    ok: true,
    data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'tok-secreto', environment: 'homologacao' } },
  })
}

describe('syncFocusEmpresa', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('company_fiscal_settings ausente → falha cedo, sem chamar a Focus', async () => {
    mockSettingsRow(null)
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('CRT ausente → falha, nunca assume um regime tributário', async () => {
    mockSettingsRow({ ...COMPLETE_SETTINGS, crt: null })
    mockAvailableIntegration()

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/regime tributário/i)
  })

  it('CNPJ não encontrado na Focus → cria (POST), nunca duplicata', async () => {
    mockSettingsRow(COMPLETE_SETTINGS)
    mockAvailableIntegration()
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 42, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })
    const updateSpy = vi.spyOn(httpClient, 'updateFocusEmpresa')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.action).toBe('created')
    expect(createSpy).toHaveBeenCalledOnce()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('CNPJ já cadastrado na Focus → atualiza (PUT), nunca cria duplicata', async () => {
    mockSettingsRow(COMPLETE_SETTINGS)
    mockAvailableIntegration()
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([{ id: 77, cnpj: COMPLETE_SETTINGS.cnpj, nome: 'Nome antigo' }])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa')
    const updateSpy = vi.spyOn(httpClient, 'updateFocusEmpresa').mockResolvedValue({ id: 77, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: '2027-01-01' })

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.action).toBe('updated')
      expect(result.data.focusEmpresaId).toBe(77)
    }
    expect(updateSpy).toHaveBeenCalledWith(77, expect.anything(), expect.anything())
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('regime_tributario enviado à Focus é sempre o crt de company_fiscal_settings — nunca hardcoded (suporta transição MEI→ME sem mudar código)', async () => {
    mockSettingsRow({ ...COMPLETE_SETTINGS, crt: 1 }) // já migrada pra Simples Nacional normal
    mockAvailableIntegration()
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1)
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ regime_tributario: 1 }), expect.anything())
  })

  it('certificado/senha passam pro input da Focus, mas nunca aparecem na mensagem de erro se a chamada falhar', async () => {
    mockSettingsRow(COMPLETE_SETTINGS)
    mockAvailableIntegration()
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    vi.spyOn(httpClient, 'createFocusEmpresa').mockRejectedValue(new Error('HTTP 422: cnpj inválido'))

    const result = await syncFocusEmpresa(1, { arquivoBase64: 'BASE64-SUPER-SECRETO-DO-CERTIFICADO', senha: 'senha-secreta-123' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('BASE64-SUPER-SECRETO-DO-CERTIFICADO')
      expect(result.error).not.toContain('senha-secreta-123')
    }
  })

  it('integração Focus indisponível → falha sem chamar listFocusEmpresas', async () => {
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'token_missing' } })
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })
})
