import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Setup necessário ANTES de importar o script (efeitos de módulo:
// parsing de --company-id/--execute, criação do client Supabase) ───────────
process.argv = ['node', 'chatwoot-customer-backfill.mjs', '--company-id', '1', '--execute']
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-fake'

const mockClient = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockClient,
}))

const { processCustomer, counters } = await import('./chatwoot-customer-backfill.mjs')

// ─── Helpers de mock ────────────────────────────────────────────────────────

/** Builder encadeável (.select/.eq/.maybeSingle/await direto). `getNextResult` decide a resposta — compartilhado entre TODAS as chamadas a .from() da mesma tabela (não por instância de builder), pra sequenciar corretamente chamadas repetidas à mesma tabela dentro de 1 processCustomer(). */
function makeSequencedBuilder(getNextResult) {
  return {
    select: () => {
      const result = getNextResult()
      const chain = {
        eq: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve) => resolve(result),
      }
      return chain
    },
    insert: () => Promise.resolve({ data: null, error: null }),
  }
}

function configureSupabase(tableResponses, rpcResponses = {}) {
  const callIndexByTable = {}
  mockClient.from.mockImplementation((table) => {
    const responses = tableResponses[table] ?? [{ data: null, error: null }]
    return makeSequencedBuilder(() => {
      const idx = callIndexByTable[table] ?? 0
      callIndexByTable[table] = idx + 1
      return responses[Math.min(idx, responses.length - 1)]
    })
  })
  mockClient.rpc.mockImplementation((fn) => Promise.resolve(rpcResponses[fn] ?? { data: null, error: null }))
}

function resetCounters() {
  for (const key of Object.keys(counters)) counters[key] = 0
}

function mockFetchSequence(responses) {
  let callIndex = 0
  const fn = vi.fn().mockImplementation(() => {
    const r = responses[Math.min(callIndex, responses.length - 1)]
    callIndex++
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body ?? {}),
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const CONFIG = { baseUrl: 'https://chat.example.com', accountId: '1', apiToken: 'token', integrationId: 9 }
const CUSTOMER = { id: 275, name: 'Fulana', phone_e164: '5584999999999', is_anonymous: false }

beforeEach(() => {
  resetCounters()
  vi.restoreAllMocks()
  mockClient.from.mockReset()
  mockClient.rpc.mockReset()
})

describe('processCustomer — customer já vinculado ao Chatwoot (already_linked)', () => {
  it('reutiliza o contact_id existente (nunca busca/cria contato novo no Chatwoot)', async () => {
    configureSupabase(
      {
        crm_person_customer_links: [{ data: [{ id: 1, person_id: 42, is_primary: true }], error: null }],
        external_entity_links: [{ data: { external_id: '999' }, error: null }],
        sales: [{ data: [], error: null }],
        mv_customer_rfm: [{ data: null, error: null }],
        v_cashback_balance: [{ data: null, error: null }],
      },
      { rpc_customer_purchase_profile: { data: [], error: null } },
    )
    const fetchSpy = mockFetchSequence([{ body: { custom_attributes: {} } }, { body: {} }])

    const result = await processCustomer(CUSTOMER, CONFIG, 7)

    expect(result).toEqual({ status: 'synced', personId: 42, contactId: '999' })
    // Só 2 chamadas HTTP: GET contato + PUT atributos — nunca /contacts/search nem POST /contacts.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const urls = fetchSpy.mock.calls.map((c) => c[0])
    expect(urls.some((u) => u.includes('/contacts/search'))).toBe(false)
    expect(urls[0]).toContain('/contacts/999')
    expect(urls[1]).toContain('/contacts/999')
  })

  it('não cria nova identidade (nunca chama rpc_find_or_create_crm_person_by_identity)', async () => {
    configureSupabase(
      {
        crm_person_customer_links: [{ data: [{ id: 1, person_id: 42, is_primary: true }], error: null }],
        external_entity_links: [{ data: { external_id: '999' }, error: null }],
        sales: [{ data: [], error: null }],
      },
      { rpc_customer_purchase_profile: { data: [], error: null } },
    )
    mockFetchSequence([{ body: { custom_attributes: {} } }, { body: {} }])

    await processCustomer(CUSTOMER, CONFIG, 7)

    const identityCalls = mockClient.rpc.mock.calls.filter((c) => c[0] === 'rpc_find_or_create_crm_person_by_identity')
    expect(identityCalls).toHaveLength(0)
  })

  it('sincroniza os atributos comerciais (chama PUT custom_attributes e conta attributes_synced, junto com already_linked)', async () => {
    configureSupabase(
      {
        crm_person_customer_links: [{ data: [{ id: 1, person_id: 42, is_primary: true }], error: null }],
        external_entity_links: [{ data: { external_id: '999' }, error: null }],
        sales: [{ data: [{ total: 100, sale_date: '2026-01-10', status: 'paid' }], error: null }],
        mv_customer_rfm: [{ data: { segment: 'champions' }, error: null }],
        v_cashback_balance: [{ data: { available_balance: 20 }, error: null }],
      },
      { rpc_customer_purchase_profile: { data: [], error: null } },
    )
    const fetchSpy = mockFetchSequence([{ body: { custom_attributes: { other_field: 'preservado' } } }, { body: {} }])

    await processCustomer(CUSTOMER, CONFIG, 7)

    const putCall = fetchSpy.mock.calls.find((c) => c[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.custom_attributes.qarvon_customer_id).toBe('275')
    expect(body.custom_attributes.qarvon_total_orders).toBe(1)
    expect(body.custom_attributes.other_field).toBe('preservado') // merge nunca sobrescreve atributo alheio

    expect(counters.already_linked).toBe(1)
    expect(counters.attributes_synced).toBe(1)
  })

  it('chama rpc_customer_purchase_profile e inclui qarvon_categories/qarvon_size_* no payload', async () => {
    configureSupabase(
      {
        crm_person_customer_links: [{ data: [{ id: 1, person_id: 42, is_primary: true }], error: null }],
        external_entity_links: [{ data: { external_id: '999' }, error: null }],
        sales: [{ data: [], error: null }],
      },
      {
        rpc_customer_purchase_profile: {
          data: [{ product_type_slug: 'pijama', product_type_name: 'Pijama', total_quantity: 3, dominant_size: 'M' }],
          error: null,
        },
      },
    )
    const fetchSpy = mockFetchSequence([{ body: { custom_attributes: {} } }, { body: {} }])

    await processCustomer(CUSTOMER, CONFIG, 7)

    expect(mockClient.rpc).toHaveBeenCalledWith('rpc_customer_purchase_profile', { p_customer_id: 275, p_company_id: 1 })
    const putCall = fetchSpy.mock.calls.find((c) => c[1]?.method === 'PUT')
    const body = JSON.parse(putCall[1].body)
    expect(body.custom_attributes.qarvon_categories).toBe('Pijama')
    expect(body.custom_attributes.qarvon_size_pijama).toBe('M')
  })
})

describe('processCustomer — conflito de identidade continua sendo pulado', () => {
  it('telefone já vinculado a OUTRO customer → skipped_phone_identity_conflict, nunca sincroniza', async () => {
    configureSupabase(
      {
        // 1ª chamada: sem vínculo existente pra este customer.
        // 2ª chamada (otherLinks, após a RPC de identidade): vínculo já existe, mas de OUTRO customer_id.
        crm_person_customer_links: [
          { data: [], error: null },
          { data: [{ id: 5, customer_id: 999 }], error: null },
        ],
      },
      { rpc_find_or_create_crm_person_by_identity: { data: { person_id: 42 }, error: null } },
    )
    const fetchSpy = mockFetchSequence([])

    const result = await processCustomer(CUSTOMER, CONFIG, 7)

    expect(result).toEqual({ status: 'skipped_phone_identity_conflict' })
    expect(counters.skipped_phone_identity_conflict).toBe(1)
    expect(counters.attributes_synced).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
