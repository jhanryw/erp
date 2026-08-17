import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveChatwootLink } from './resolveChatwootLink'
import * as auth from '@/lib/auth/requireAutomationSecret'
import * as adminModule from '@/lib/supabase/admin'
import * as reconciliation from '@/lib/integrations/chatwoot/reconciliation'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'
import * as externalLinks from '@/services/integrations/external-entity-links.service'

// ─── resolveChatwootLink — reaproveita a mesma cadeia da Fase 2/4, sem nunca criar vínculo ────

describe('resolveChatwootLink (seção 12 do pedido)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sem integração Chatwoot ativa → linked:false', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null } as any)
    const personSpy = vi.spyOn(reconciliation, 'resolvePersonForCustomer')

    const result = await resolveChatwootLink(1, 275)

    expect(result).toEqual({ linked: false, contact_id: null })
    expect(personSpy).not.toHaveBeenCalled()
  })

  it('integração existe mas status != active → linked:false', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { id: 9, status: 'inactive' } } as any)

    const result = await resolveChatwootLink(1, 275)

    expect(result).toEqual({ linked: false, contact_id: null })
  })

  it('pessoa não resolvida (não encontrada/ambígua) → linked:false, nunca cria vínculo', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { id: 9, status: 'active' } } as any)
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'not_found' } } as any)
    const linkSpy = vi.spyOn(externalLinks, 'findLinkForEntity')

    const result = await resolveChatwootLink(1, 275)

    expect(result).toEqual({ linked: false, contact_id: null })
    expect(linkSpy).not.toHaveBeenCalled()
  })

  it('pessoa resolvida mas sem link externo ativo → linked:false', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { id: 9, status: 'active' } } as any)
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'resolved', personId: 42 } } as any)
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: null } as any)

    const result = await resolveChatwootLink(1, 275)

    expect(result).toEqual({ linked: false, contact_id: null })
  })

  it('pessoa resolvida + link externo ativo → linked:true com contact_id', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { id: 9, status: 'active' } } as any)
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'resolved', personId: 42 } } as any)
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: { external_id: '123' } } as any)

    const result = await resolveChatwootLink(1, 275)

    expect(result).toEqual({ linked: true, contact_id: '123' })
  })
})

// ─── Rota — auth/tenant/recurso, contrato REST (404, não found:false) ─────────

function makeCustomerQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
  }
  return builder
}

function mockAdminCustomer(data: unknown, error: unknown = null) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => makeCustomerQueryBuilder({ data, error }),
  } as any)
}

function mockNoChatwootLink() {
  vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null } as any)
}

async function callGet(id: string) {
  const { GET } = await import('./route')
  return GET(new Request(`https://example.com/api/automations/customers/${id}/360`), { params: { id } })
}

describe('GET /api/automations/customers/:id/360 — auth, tenant e recurso (seção 17 do pedido)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('secret inválido/ausente → 401, nunca consulta banco', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(false)
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')

    const response = await callGet('275')

    expect(response.status).toBe(401)
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('tenant não configurado → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: false, reason: 'missing_config' })
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')

    const response = await callGet('275')

    expect(response.status).toBe(500)
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('id inválido (não numérico) → 422', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })

    const response = await callGet('abc')

    expect(response.status).toBe(422)
  })

  it('customer inexistente (ou de outro tenant — mesma query .eq(company_id)) → 404', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer(null)

    const response = await callGet('999999')

    expect(response.status).toBe(404)
  })

  it('customer anônimo → 404 (mesma política do lookup)', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer({ id: 5, name: 'Avulso', phone_e164: null, is_anonymous: true })

    const response = await callGet('5')

    expect(response.status).toBe(404)
  })

  it('erro de consulta → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer(null, { message: 'conexão perdida' })

    const response = await callGet('275')

    expect(response.status).toBe(500)
  })

  it('customer existente sem compras → 200 com totals zerados, sem CPF/endereço/margem/custo', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer({ id: 275, name: 'Fulana', phone_e164: '5584999999999', is_anonymous: false })
    vi.spyOn(reconciliation, 'computeCustomerCommercialAttributes').mockResolvedValue({
      ok: true,
      data: {
        totalOrders: 0,
        totalSpent: 0,
        averageTicket: 0,
        firstPurchaseAt: null,
        lastPurchaseAt: null,
        customerSegment: 'novo',
      },
    } as any)
    mockNoChatwootLink()

    const response = await callGet('275')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      customer_id: 275,
      name: 'Fulana',
      phone_e164: '5584999999999',
      total_orders: 0,
      total_spent: 0,
      average_ticket: 0,
      first_purchase_at: null,
      last_purchase_at: null,
      customer_segment: 'novo',
      chatwoot: { linked: false, contact_id: null },
    })
    expect(Object.keys(body)).not.toContain('cpf')
    expect(Object.keys(body)).not.toContain('address')
    expect(Object.keys(body)).not.toContain('margin')
    expect(Object.keys(body)).not.toContain('cost')
  })

  it('customer com compras e Chatwoot vinculado → 200 com totals e chatwoot.linked:true', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer({ id: 275, name: 'Fulana', phone_e164: '5584999999999', is_anonymous: false })
    vi.spyOn(reconciliation, 'computeCustomerCommercialAttributes').mockResolvedValue({
      ok: true,
      data: {
        totalOrders: 5,
        totalSpent: 742.9,
        averageTicket: 148.58,
        firstPurchaseAt: '2025-01-01T00:00:00Z',
        lastPurchaseAt: '2026-08-01T00:00:00Z',
        customerSegment: 'vip',
      },
    } as any)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { id: 9, status: 'active' } } as any)
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'resolved', personId: 42 } } as any)
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: { external_id: '123' } } as any)

    const response = await callGet('275')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.total_orders).toBe(5)
    expect(body.total_spent).toBe(742.9)
    expect(body.average_ticket).toBe(148.58)
    expect(body.customer_segment).toBe('vip')
    expect(body.chatwoot).toEqual({ linked: true, contact_id: '123' })
  })

  it('erro ao calcular atributos comerciais → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminCustomer({ id: 275, name: 'Fulana', phone_e164: '5584999999999', is_anonymous: false })
    vi.spyOn(reconciliation, 'computeCustomerCommercialAttributes').mockResolvedValue({ ok: false, error: 'erro' } as any)

    const response = await callGet('275')

    expect(response.status).toBe(500)
  })
})
