import { describe, it, expect, vi, afterEach } from 'vitest'
import { consultNfeStatus } from './consultNfeStatus'
import * as resolveModule from './resolveFocusIntegration'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, mockCreateAdminClient } from './testFakeAdminClient'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 777

describe('consultNfeStatus — polling manual, nunca automático', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('nenhuma tentativa de emissão pra essa venda → falha 404, sem chamar Focus', async () => {
    const fake = createFakeAdmin()
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe')

    const result = await consultNfeStatus(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    expect(consultSpy).not.toHaveBeenCalled()
  })

  it('consulta a MESMA ref já usada na tentativa anterior, atualiza o status', async () => {
    const fake = createFakeAdmin()
    const seeded = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: 'qarvon-1-777-nfe', status: 'pending',
    })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))

    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado',
      chave_nfe: 'chave-teste',
      numero: '1',
      serie: '1',
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NF-e',
    })

    const result = await consultNfeStatus(SALE_ID, COMPANY_ID)

    expect(consultSpy).toHaveBeenCalledWith('qarvon-1-777-nfe', expect.anything())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('chave-teste')
    }
    expect(fake.tables.fiscal_documents.find((r) => r.id === seeded.id)?.status).toBe('authorized')
  })

  it('não é um loop — uma chamada de consultNfeStatus faz exatamente UMA chamada HTTP à Focus', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: 'qarvon-1-777-nfe', status: 'pending',
    })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    await consultNfeStatus(SALE_ID, COMPANY_ID)
    expect(consultSpy).toHaveBeenCalledTimes(1)
  })
})
