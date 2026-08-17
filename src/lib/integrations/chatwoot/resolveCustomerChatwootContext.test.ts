import { describe, it, expect, vi, afterEach } from 'vitest'
import * as adminModule from '@/lib/supabase/admin'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'
import * as secretsService from '@/services/integrations/secrets.service'
import * as externalLinks from '@/services/integrations/external-entity-links.service'
import * as reconciliation from './reconciliation'
import * as customerIdentity from '@/services/crm/customer-identity.service'
import * as channelIdentities from '@/services/crm/channel-identities.service'
import * as client from './client'
import {
  resolveCustomerChatwootContext,
  resolveCustomerIdForAutomation,
  sendChatwootMessageToCustomer,
} from './resolveCustomerChatwootContext'

const COMPANY_ID = 1

const CUSTOMER = { id: 275, name: 'Fulana', phone_e164: '5584999999999', is_anonymous: false }
const INTEGRATION = {
  id: 9,
  company_id: COMPANY_ID,
  provider: 'chatwoot' as const,
  external_account_id: '1',
  status: 'active' as const,
  settings: { base_url: 'https://chat.example.com', inbox_id: 7 },
  last_error: null,
  created_at: '',
  updated_at: '',
  created_by: null,
}

function customerQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

/** Mocka createAdminClient pra devolver `customerResult` na primeira query de `customers` (usada por resolveCustomerRow — a ÚNICA leitura direta de banco deste módulo). */
function mockCustomerLookup(data: unknown, error: unknown = null) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => customerQueryBuilder({ data, error }),
  } as any)
}

/** Configura o "caminho feliz" completo — cada teste sobrescreve só o que precisa. */
function mockHappyPathDefaults() {
  mockCustomerLookup(CUSTOMER)
  vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: INTEGRATION } as any)
  vi.spyOn(secretsService, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: 'token-abc' } as any)
  vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'resolved', personId: 42 } } as any)
  vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: { id: 1, external_id: '2' } } as any)
  vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [{ id: 11, status: 'open', inbox_id: 7 }] } as any)
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Resolução de customer (customer_id prioridade, phone, ambíguo, anônimo) ──

describe('resolveCustomerChatwootContext — resolução de customer', () => {
  it('customer_id válido → prioridade sobre phone (nunca consulta por telefone)', async () => {
    mockHappyPathDefaults()
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275, phone: '84999999999' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ status: 'resolved', customerId: 275, contactId: 2, conversationId: 11, inboxId: 7 })
  })

  it('customer inexistente (ou de outro tenant — mesma query .eq(company_id)) → customer_not_found', async () => {
    mockCustomerLookup(null)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 999999 })
    expect(result).toEqual({ ok: true, data: { status: 'customer_not_found' } })
  })

  it('customer anônimo → anonymous_customer', async () => {
    mockCustomerLookup({ ...CUSTOMER, is_anonymous: true })
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 5 })
    expect(result).toEqual({ ok: true, data: { status: 'anonymous_customer' } })
  })

  it('customer sem phone_e164 → customer_missing_phone', async () => {
    mockCustomerLookup({ ...CUSTOMER, phone_e164: null })
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result).toEqual({ ok: true, data: { status: 'customer_missing_phone' } })
  })

  it('telefone válido (com máscara) → normaliza via normalizeE164BR e resolve', async () => {
    mockHappyPathDefaults()
    mockCustomerLookup([CUSTOMER])
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { phone: '(84) 99999-9999' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toMatchObject({ status: 'resolved', customerId: 275 })
  })

  it('telefone inexistente na base → customer_not_found', async () => {
    mockCustomerLookup([])
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { phone: '84999999999' })
    expect(result).toEqual({ ok: true, data: { status: 'customer_not_found' } })
  })

  it('telefone inválido/não normalizável → customer_not_found, nunca consulta banco', async () => {
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { phone: '123' })
    expect(result).toEqual({ ok: true, data: { status: 'customer_not_found' } })
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('telefone ambíguo (2+ customers) → ambiguous_customer', async () => {
    mockCustomerLookup([CUSTOMER, { ...CUSTOMER, id: 276 }])
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { phone: '84999999999' })
    expect(result).toEqual({ ok: true, data: { status: 'ambiguous_customer' } })
  })

  it('nem customer_id nem phone → erro 422', async () => {
    const result = await resolveCustomerChatwootContext(COMPANY_ID, {})
    expect(result).toEqual({ ok: false, error: 'Informe "customer_id" ou "phone".', status: 422 })
  })
})

// ─── Integração/config (inclui "integração inactive", "token ausente") ────────

describe('resolveCustomerChatwootContext — integração Chatwoot', () => {
  it('sem integração configurada → chatwoot_not_configured', async () => {
    mockCustomerLookup(CUSTOMER)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status).toBe('chatwoot_not_configured')
  })

  it('integração inactive → chatwoot_not_configured', async () => {
    mockCustomerLookup(CUSTOMER)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { ...INTEGRATION, status: 'inactive' } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status).toBe('chatwoot_not_configured')
  })

  it('settings.inbox_id ausente → chatwoot_not_configured', async () => {
    mockCustomerLookup(CUSTOMER)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { ...INTEGRATION, settings: { base_url: 'https://chat.example.com' } } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status).toBe('chatwoot_not_configured')
  })

  it('settings.base_url ausente → chatwoot_not_configured', async () => {
    mockCustomerLookup(CUSTOMER)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: { ...INTEGRATION, settings: { inbox_id: 7 } } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status).toBe('chatwoot_not_configured')
  })

  it('api_token ausente → chatwoot_not_configured (nunca chama o Chatwoot)', async () => {
    mockCustomerLookup(CUSTOMER)
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: INTEGRATION } as any)
    vi.spyOn(secretsService, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: null } as any)
    const searchSpy = vi.spyOn(client, 'searchChatwootContacts')
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status).toBe('chatwoot_not_configured')
    expect(searchSpy).not.toHaveBeenCalled()
  })
})

// ─── crm_person (ambíguo, sem pessoa → cria, já resolvido) ─────────────────────

describe('resolveCustomerChatwootContext — crm_person', () => {
  it('crm_person ambígua → contact_ambiguous', async () => {
    mockHappyPathDefaults()
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'ambiguous' } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result).toEqual({ ok: true, data: { status: 'contact_ambiguous' } })
  })

  it('sem crm_person (no_person) → cria via findOrCreateChannelIdentity + linkPersonToCustomerIfConfident', async () => {
    mockHappyPathDefaults()
    vi.spyOn(reconciliation, 'resolvePersonForCustomer').mockResolvedValue({ ok: true, data: { status: 'no_person' } } as any)
    const createIdentitySpy = vi.spyOn(channelIdentities, 'findOrCreateChannelIdentity').mockResolvedValue({ ok: true, data: { personId: 42, channelIdentityId: 1, personCreated: true, identityCreated: true } } as any)
    const linkSpy = vi.spyOn(customerIdentity, 'linkPersonToCustomerIfConfident').mockResolvedValue({ ok: true, data: { tier: 'HIGH_CONFIDENCE', link: null } } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createIdentitySpy).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, channelType: 'whatsapp', value: '5584999999999' }))
    expect(linkSpy).toHaveBeenCalledWith(42, COMPANY_ID)
    expect(result.ok && result.data.status).toBe('resolved')
  })

  it('crm_person já resolvida → nunca chama findOrCreateChannelIdentity', async () => {
    mockHappyPathDefaults()
    const createIdentitySpy = vi.spyOn(channelIdentities, 'findOrCreateChannelIdentity')
    await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(createIdentitySpy).not.toHaveBeenCalled()
  })
})

// ─── Contato Chatwoot (linkado, existente não linkado, criação, ambíguo, idempotência) ──

describe('resolveCustomerChatwootContext — contato Chatwoot', () => {
  it('contato já linkado → reaproveita, nunca busca/cria no Chatwoot (idempotência)', async () => {
    mockHappyPathDefaults()
    const searchSpy = vi.spyOn(client, 'searchChatwootContacts')
    const createSpy = vi.spyOn(client, 'createChatwootContact')

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(result.ok && result.data.status === 'resolved' && result.data.contactId).toBe(2)
    expect(searchSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('sem link, contato já existe no Chatwoot (match exato de telefone) → reaproveita, nunca cria', async () => {
    mockHappyPathDefaults()
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: null } as any)
    vi.spyOn(client, 'searchChatwootContacts').mockResolvedValue({ ok: true, data: [{ id: 5, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] }] } as any)
    const createSpy = vi.spyOn(client, 'createChatwootContact')
    const linkCreateSpy = vi.spyOn(externalLinks, 'linkExternalEntity').mockResolvedValue({ ok: true, data: {} } as any)
    vi.spyOn(client, 'getContactableInboxes').mockResolvedValue({ ok: true, data: [{ source_id: 'src-1', inbox: { id: 7 } }] } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createSpy).not.toHaveBeenCalled()
    expect(linkCreateSpy).toHaveBeenCalledWith(expect.objectContaining({ externalId: '5' }))
    expect(result.ok && result.data.status === 'resolved' && result.data.contactId).toBe(5)
  })

  it('busca ignora match de telefone diferente (busca do Chatwoot é fuzzy) → cria contato novo', async () => {
    mockHappyPathDefaults()
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: null } as any)
    vi.spyOn(client, 'searchChatwootContacts').mockResolvedValue({ ok: true, data: [{ id: 5, name: 'Fulana Parecida', phone_number: '+5511988887777', contact_inboxes: [] }] } as any)
    const createSpy = vi.spyOn(client, 'createChatwootContact').mockResolvedValue({ ok: true, data: { contact: { id: 6, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] }, sourceId: 'src-novo' } } as any)
    vi.spyOn(externalLinks, 'linkExternalEntity').mockResolvedValue({ ok: true, data: {} } as any)
    vi.spyOn(client, 'createChatwootConversation').mockResolvedValue({ ok: true, data: { id: 20, inbox_id: 7 } } as any)
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [] } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createSpy).toHaveBeenCalledWith(expect.anything(), { inboxId: 7, phoneNumber: '+5584999999999', name: 'Fulana' })
    expect(result.ok && result.data.status === 'resolved' && result.data.contactId).toBe(6)
  })

  it('sem link, sem contato no Chatwoot → cria contato', async () => {
    mockHappyPathDefaults()
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: null } as any)
    vi.spyOn(client, 'searchChatwootContacts').mockResolvedValue({ ok: true, data: [] } as any)
    const createSpy = vi.spyOn(client, 'createChatwootContact').mockResolvedValue({ ok: true, data: { contact: { id: 6, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] }, sourceId: 'src-novo' } } as any)
    vi.spyOn(externalLinks, 'linkExternalEntity').mockResolvedValue({ ok: true, data: {} } as any)
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [] } as any)
    vi.spyOn(client, 'createChatwootConversation').mockResolvedValue({ ok: true, data: { id: 20, inbox_id: 7 } } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createSpy).toHaveBeenCalledOnce()
    expect(result.ok && result.data.status === 'resolved' && result.data.contactId).toBe(6)
  })

  it('2+ contatos com telefone exato idêntico no Chatwoot → contact_ambiguous, nunca escolhe um', async () => {
    mockHappyPathDefaults()
    vi.spyOn(externalLinks, 'findLinkForEntity').mockResolvedValue({ ok: true, data: null } as any)
    vi.spyOn(client, 'searchChatwootContacts').mockResolvedValue({
      ok: true,
      data: [
        { id: 5, name: 'A', phone_number: '+5584999999999', contact_inboxes: [] },
        { id: 6, name: 'B', phone_number: '+5584999999999', contact_inboxes: [] },
      ],
    } as any)
    const createSpy = vi.spyOn(client, 'createChatwootContact')

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(result).toEqual({ ok: true, data: { status: 'contact_ambiguous' } })
    expect(createSpy).not.toHaveBeenCalled()
  })
})

// ─── Conversation (existente, criação, resolved não reaproveitada, outra inbox, idempotência) ──

describe('resolveCustomerChatwootContext — conversation', () => {
  it('conversa open existente na inbox → reaproveita, nunca cria (idempotência)', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [{ id: 11, status: 'open', inbox_id: 7 }] } as any)
    const createConvSpy = vi.spyOn(client, 'createChatwootConversation')

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(result.ok && result.data.status === 'resolved' && result.data.conversationId).toBe(11)
    expect(createConvSpy).not.toHaveBeenCalled()
  })

  it('sem open, conversa pending existente → reaproveita', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [{ id: 12, status: 'pending', inbox_id: 7 }] } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data.status === 'resolved' && result.data.conversationId).toBe(12)
  })

  it('só conversa resolved → NUNCA reaproveita, cria nova', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [{ id: 13, status: 'resolved', inbox_id: 7 }] } as any)
    vi.spyOn(client, 'getContactableInboxes').mockResolvedValue({ ok: true, data: [{ source_id: 'src-1', inbox: { id: 7 } }] } as any)
    const createConvSpy = vi.spyOn(client, 'createChatwootConversation').mockResolvedValue({ ok: true, data: { id: 99, inbox_id: 7 } } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createConvSpy).toHaveBeenCalledOnce()
    expect(result.ok && result.data.status === 'resolved' && result.data.conversationId).toBe(99)
  })

  it('conversa aberta existe só em OUTRA inbox → nunca reaproveita, cria nova na inbox certa', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [{ id: 14, status: 'open', inbox_id: 999 }] } as any)
    vi.spyOn(client, 'getContactableInboxes').mockResolvedValue({ ok: true, data: [{ source_id: 'src-1', inbox: { id: 7 } }] } as any)
    const createConvSpy = vi.spyOn(client, 'createChatwootConversation').mockResolvedValue({ ok: true, data: { id: 100, inbox_id: 7 } } as any)

    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createConvSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inboxId: 7 }))
    expect(result.ok && result.data.status === 'resolved' && result.data.conversationId).toBe(100)
  })

  it('criação de conversa sem contact_inbox existente → cria contact_inbox primeiro', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: true, data: [] } as any)
    vi.spyOn(client, 'getContactableInboxes').mockResolvedValue({ ok: true, data: [] } as any)
    const createContactInboxSpy = vi.spyOn(client, 'createContactInbox').mockResolvedValue({ ok: true, data: { source_id: 'src-criado' } } as any)
    const createConvSpy = vi.spyOn(client, 'createChatwootConversation').mockResolvedValue({ ok: true, data: { id: 101, inbox_id: 7 } } as any)

    await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })

    expect(createContactInboxSpy).toHaveBeenCalledWith(expect.anything(), '2', 7)
    expect(createConvSpy).toHaveBeenCalledWith(expect.anything(), { sourceId: 'src-criado', inboxId: 7, contactId: '2' })
  })
})

// ─── Erros do Chatwoot (401/429/500/timeout) ───────────────────────────────────

describe('resolveCustomerChatwootContext — erros do Chatwoot', () => {
  it('401 → chatwoot_unavailable, permanent:true (erro de config/token, não retry)', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: false, error: { kind: 'http', status: 401, message: 'Unauthorized' } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data).toMatchObject({ status: 'chatwoot_unavailable', permanent: true })
  })

  it('429 → chatwoot_unavailable, permanent:false, propaga retryAfterSeconds', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: false, error: { kind: 'http', status: 429, message: 'Too Many Requests', retryAfterSeconds: 30 } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data).toMatchObject({ status: 'chatwoot_unavailable', permanent: false, retryAfterSeconds: 30 })
  })

  it('500 → chatwoot_unavailable, permanent:false', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: false, error: { kind: 'http', status: 500, message: 'Internal Server Error' } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data).toMatchObject({ status: 'chatwoot_unavailable', permanent: false })
  })

  it('timeout → chatwoot_unavailable, permanent:false', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'listContactConversations').mockResolvedValue({ ok: false, error: { kind: 'timeout', message: 'Timeout' } } as any)
    const result = await resolveCustomerChatwootContext(COMPANY_ID, { customerId: 275 })
    expect(result.ok && result.data).toMatchObject({ status: 'chatwoot_unavailable', permanent: false })
  })
})

// ─── resolveCustomerIdForAutomation ─────────────────────────────────────────────

describe('resolveCustomerIdForAutomation', () => {
  it('customer resolvido → {customerId}', async () => {
    mockCustomerLookup(CUSTOMER)
    const result = await resolveCustomerIdForAutomation(COMPANY_ID, { customerId: 275 })
    expect(result).toEqual({ ok: true, data: { customerId: 275 } })
  })

  it('customer sem telefone → outcome customer_missing_phone', async () => {
    mockCustomerLookup({ ...CUSTOMER, phone_e164: null })
    const result = await resolveCustomerIdForAutomation(COMPANY_ID, { customerId: 275 })
    expect(result).toEqual({ ok: true, data: { outcome: { status: 'customer_missing_phone' } } })
  })

  it('customer inexistente → outcome customer_not_found', async () => {
    mockCustomerLookup(null)
    const result = await resolveCustomerIdForAutomation(COMPANY_ID, { customerId: 999 })
    expect(result).toEqual({ ok: true, data: { outcome: { status: 'customer_not_found' } } })
  })
})

// ─── sendChatwootMessageToCustomer ──────────────────────────────────────────────

describe('sendChatwootMessageToCustomer', () => {
  it('resolvido → envia e devolve status sent com messageId', async () => {
    mockHappyPathDefaults()
    const sendSpy = vi.spyOn(client, 'createChatwootMessage').mockResolvedValue({ ok: true, data: { id: 555, content: 'oi' } } as any)

    const result = await sendChatwootMessageToCustomer(COMPANY_ID, { customerId: 275 }, 'oi')

    expect(sendSpy).toHaveBeenCalledWith(expect.anything(), 11, 'oi')
    expect(result).toEqual({ ok: true, data: { status: 'sent', customerId: 275, conversationId: 11, messageId: 555 } })
  })

  it('resolução falha (ex.: customer_not_found) → nunca chama createChatwootMessage', async () => {
    mockCustomerLookup(null)
    const sendSpy = vi.spyOn(client, 'createChatwootMessage')

    const result = await sendChatwootMessageToCustomer(COMPANY_ID, { customerId: 999 }, 'oi')

    expect(result).toEqual({ ok: true, data: { status: 'customer_not_found' } })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('envio falha (Chatwoot 500) → chatwoot_unavailable', async () => {
    mockHappyPathDefaults()
    vi.spyOn(client, 'createChatwootMessage').mockResolvedValue({ ok: false, error: { kind: 'http', status: 500, message: 'Internal Server Error' } } as any)

    const result = await sendChatwootMessageToCustomer(COMPANY_ID, { customerId: 275 }, 'oi')

    expect(result.ok && result.data).toMatchObject({ status: 'chatwoot_unavailable', permanent: false })
  })
})
