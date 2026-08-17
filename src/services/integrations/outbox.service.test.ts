import { describe, it, expect, vi, afterEach } from 'vitest'
import { isProviderActiveForCompany, buildOutboxEventId } from './outbox.service'
import * as companyIntegrations from './company-integrations.service'

describe('isProviderActiveForCompany — fan-out só cria delivery com integração ativa (seção 4 do pedido da Fase 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('integração chatwoot ativa → true', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({
      ok: true,
      data: { id: 1, company_id: 1, provider: 'chatwoot', external_account_id: '1', status: 'active', settings: {}, last_error: null, created_at: '', updated_at: '', created_by: null },
    })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(true)
  })

  it('integração chatwoot pending → false (não cria delivery)', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({
      ok: true,
      data: { id: 1, company_id: 1, provider: 'chatwoot', external_account_id: null, status: 'pending', settings: {}, last_error: null, created_at: '', updated_at: '', created_by: null },
    })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(false)
  })

  it('integração chatwoot inactive → false', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({
      ok: true,
      data: { id: 1, company_id: 1, provider: 'chatwoot', external_account_id: '1', status: 'inactive', settings: {}, last_error: null, created_at: '', updated_at: '', created_by: null },
    })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(false)
  })

  it('integração chatwoot em error → false', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({
      ok: true,
      data: { id: 1, company_id: 1, provider: 'chatwoot', external_account_id: '1', status: 'error', settings: {}, last_error: 'token inválido', created_at: '', updated_at: '', created_by: null },
    })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(false)
  })

  it('empresa sem NENHUMA integração chatwoot cadastrada → false, evento continua válido (não lança)', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(false)
  })

  it('destino "n8n" nunca é considerado provider ativo (não modelado em company_integrations) — nem consulta o banco', async () => {
    const spy = vi.spyOn(companyIntegrations, 'getCompanyIntegration')
    expect(await isProviderActiveForCompany(1, 'n8n')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('falha ao consultar a integração → false, conservador (nunca cria delivery sob incerteza)', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: false, error: 'timeout', status: 500 })
    expect(await isProviderActiveForCompany(1, 'chatwoot')).toBe(false)
  })
})

describe('buildOutboxEventId', () => {
  it('formato canônico usado pelas RPCs SQL', () => {
    expect(buildOutboxEventId('sale', 123, 'sale.completed')).toBe('sale:123:completed')
    expect(buildOutboxEventId('sale', 123, 'sale.cancelled')).toBe('sale:123:cancelled')
    expect(buildOutboxEventId('sale', 123, 'sale.refunded')).toBe('sale:123:refunded')
  })
})
