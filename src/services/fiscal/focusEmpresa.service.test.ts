import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { syncFocusEmpresa } from './focusEmpresa.service'
import * as managementTokenModule from './resolveFocusManagementToken'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { FocusApiError } from '@/lib/integrations/focus/types'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/integrations/company-integrations.service')

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

const INTEGRATION_ROW: companyIntegrations.CompanyIntegration = {
  id: 1,
  company_id: 1,
  provider: 'focus_nfe',
  external_account_id: null,
  status: 'active',
  settings: {},
  last_error: null,
  created_at: '',
  updated_at: '',
  created_by: null,
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

function mockAvailableManagementToken(token = 'master-tok-secreto') {
  vi.spyOn(managementTokenModule, 'resolveFocusManagementToken').mockResolvedValue({
    ok: true,
    data: { available: true, integration: { integrationId: 1, companyId: 1, token } },
  })
}

function mockIntegrationRow(overrides: Partial<companyIntegrations.CompanyIntegration> = {}) {
  ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { ...INTEGRATION_ROW, ...overrides } })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: INTEGRATION_ROW })
})

describe('syncFocusEmpresa', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('master_token indisponível → falha sem chamar a Focus', async () => {
    vi.spyOn(managementTokenModule, 'resolveFocusManagementToken').mockResolvedValue({ ok: true, data: { available: false, reason: 'master_token_missing' } })
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('integração focus_nfe inexistente → falha explícita, sem chamar a Focus', async () => {
    mockAvailableManagementToken()
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: null })
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('company_fiscal_settings ausente → falha cedo, sem chamar a Focus', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(null)
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('CRT ausente → falha, nunca assume um regime tributário', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow({ ...COMPLETE_SETTINGS, crt: null })

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/regime tributário/i)
  })

  it('REGRESSÃO DO INCIDENTE REAL (certificado nunca marcado como sincronizado): erro ao LER company_fiscal_settings (ex.: coluna ausente por migration pulada) REGISTRA falha em focusManagementSync — antes desta correção, essas 5 saídas early-return nunca chamavam recordFocusManagementSync', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: 'column company_fiscal_settings.telefone does not exist' } }),
          }),
        }),
      }),
    })

    const result = await syncFocusEmpresa(1, { certificate: { arquivoBase64: 'b64', senha: 'x' } })
    expect(result.ok).toBe(false)

    const syncCall = (companyIntegrations.updateCompanyIntegration as any).mock.calls.find((call: unknown[]) => (call[2] as any)?.settings)
    expect(syncCall).toBeTruthy() // antes da correção: nenhuma chamada, syncCall seria undefined
    const syncState = (syncCall![2] as any).settings.focusManagementSync
    expect(syncState.company.status).toBe('error')
    expect(syncState.company.lastError).toMatch(/telefone/)
    // certificate também precisa registrar erro (não ficar undefined) —
    // é exatamente isso que fazia a UI mostrar "nunca sincronizado" em
    // vez de "falhou em <data>: <erro>".
    expect(syncState.certificate.status).toBe('error')
  })

  it('company_fiscal_settings ausente (linha não existe) também registra falha em focusManagementSync', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(null)

    await syncFocusEmpresa(1)

    const syncCall = (companyIntegrations.updateCompanyIntegration as any).mock.calls.find((call: unknown[]) => (call[2] as any)?.settings)
    expect(syncCall).toBeTruthy()
    expect((syncCall![2] as any).settings.focusManagementSync.company.status).toBe('error')
  })

  it('CRT ausente também registra falha em focusManagementSync (mesma correção, cobre as 3 outras validações — CNPJ/razão social/CRT — pelo mesmo código)', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow({ ...COMPLETE_SETTINGS, crt: null })

    await syncFocusEmpresa(1)

    const syncCall = (companyIntegrations.updateCompanyIntegration as any).mock.calls.find((call: unknown[]) => (call[2] as any)?.settings)
    expect(syncCall).toBeTruthy()
    expect((syncCall![2] as any).settings.focusManagementSync.company.status).toBe('error')
  })

  it('sem external_account_id cacheado e CNPJ não encontrado na Focus → cria (POST), nunca duplicata', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow({ external_account_id: null })
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 42, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })
    const updateSpy = vi.spyOn(httpClient, 'updateFocusEmpresa')

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.action).toBe('created')
    expect(createSpy).toHaveBeenCalledOnce()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(companyIntegrations.updateCompanyIntegration).toHaveBeenCalledWith(1, 1, { externalAccountId: '42' })
  })

  it('external_account_id já cacheado → usa PUT direto, nunca busca por CNPJ', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow({ external_account_id: '77' })
    mockSettingsRow(COMPLETE_SETTINGS)
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')
    const updateSpy = vi.spyOn(httpClient, 'updateFocusEmpresa').mockResolvedValue({ id: 77, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: '2027-01-01' })

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.action).toBe('updated')
      expect(result.data.focusEmpresaId).toBe(77)
    }
    expect(updateSpy).toHaveBeenCalledWith(77, expect.anything(), expect.anything())
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('external_account_id cacheado mas obsoleto (404 na Focus) → cai pra busca por CNPJ automaticamente', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow({ external_account_id: '999' })
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'updateFocusEmpresa')
      .mockRejectedValueOnce(new FocusApiError(404, { mensagem: 'não encontrado' }))
      .mockResolvedValueOnce({ id: 55, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([{ id: 55, cnpj: COMPLETE_SETTINGS.cnpj, nome: 'Nome antigo' }])

    const result = await syncFocusEmpresa(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.focusEmpresaId).toBe(55)
  })

  it('regime_tributario enviado à Focus é sempre o crt de company_fiscal_settings — nunca hardcoded (suporta transição MEI→ME sem mudar código)', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow({ ...COMPLETE_SETTINGS, crt: 1 })
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1)
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ regime_tributario: 1 }), expect.anything())
  })

  it('gerenciamento sempre usa host/token de produção (master_token), independente do ambiente de emissão configurado', async () => {
    mockAvailableManagementToken('master-tok-secreto')
    mockIntegrationRow({ settings: { environment: 'homologacao' } })
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1)
    expect(createSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ environment: 'producao', token: 'master-tok-secreto' }))
  })

  it('certificado/senha passam pro input da Focus, mas nunca aparecem na mensagem de erro se a chamada falhar', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    vi.spyOn(httpClient, 'createFocusEmpresa').mockRejectedValue(new Error('HTTP 422: cnpj inválido'))

    const result = await syncFocusEmpresa(1, { certificate: { arquivoBase64: 'BASE64-SUPER-SECRETO-DO-CERTIFICADO', senha: 'senha-secreta-123' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('BASE64-SUPER-SECRETO-DO-CERTIFICADO')
      expect(result.error).not.toContain('senha-secreta-123')
    }
  })

  it('CSC de homologação envia só o par homologação, nunca o par de produção', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1, { csc: { environment: 'homologacao', cscId: 'id-homolog', cscToken: 'tok-homolog' } })

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ habilita_nfce: true, id_token_nfce_homologacao: 'id-homolog', csc_nfce_homologacao: 'tok-homolog' }),
      expect.anything(),
    )
    const sentInput = createSpy.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(sentInput.csc_nfce_producao).toBeUndefined()
    expect(sentInput.id_token_nfce_producao).toBeUndefined()
  })

  it('CSC de produção envia só o par produção, nunca o par de homologação', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    const createSpy = vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1, { csc: { environment: 'producao', cscId: 'id-prod', cscToken: 'tok-prod' } })

    const sentInput = createSpy.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(sentInput.csc_nfce_producao).toBe('tok-prod')
    expect(sentInput.id_token_nfce_producao).toBe('id-prod')
    expect(sentInput.csc_nfce_homologacao).toBeUndefined()
    expect(sentInput.id_token_nfce_homologacao).toBeUndefined()
  })

  it('sucesso registra status independente por recurso (company/certificate/csc) via updateCompanyIntegration', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    vi.spyOn(httpClient, 'createFocusEmpresa').mockResolvedValue({ id: 1, cnpj: COMPLETE_SETTINGS.cnpj, nome: COMPLETE_SETTINGS.razao_social, certificado_valido_ate: null })

    await syncFocusEmpresa(1, {
      certificate: { arquivoBase64: 'b64', senha: 'x' },
      csc: { environment: 'producao', cscId: 'id', cscToken: 'tok' },
    })

    const syncCall = (companyIntegrations.updateCompanyIntegration as any).mock.calls.find((call: unknown[]) => (call[2] as any)?.settings)
    expect(syncCall).toBeTruthy()
    const syncState = (syncCall![2] as any).settings.focusManagementSync
    expect(syncState.company.status).toBe('success')
    expect(syncState.certificate.status).toBe('success')
    expect(syncState.csc.producao.status).toBe('success')
    expect(syncState.csc.homologacao).toBeUndefined()
  })

  it('erro na Focus registra status=error com lastError preenchido, nunca oculta a falha', async () => {
    mockAvailableManagementToken()
    mockIntegrationRow()
    mockSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([])
    vi.spyOn(httpClient, 'createFocusEmpresa').mockRejectedValue(new Error('HTTP 500: instabilidade'))

    await syncFocusEmpresa(1, { certificate: { arquivoBase64: 'b64', senha: 'x' } })

    const syncCall = (companyIntegrations.updateCompanyIntegration as any).mock.calls.find((call: unknown[]) => (call[2] as any)?.settings)
    expect(syncCall).toBeTruthy()
    const syncState = (syncCall![2] as any).settings.focusManagementSync
    expect(syncState.company.status).toBe('error')
    expect(syncState.certificate.status).toBe('error')
    expect(syncState.company.lastError).toMatch(/instabilidade/)
  })
})
