import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getNfceDanfeData, formatAccessKey } from './getNfceDanfeData'
import { baseFiscalContext } from './testFixtures'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 9001

/**
 * Fake genérico read-only — usado pra provar tanto o comportamento normal
 * quanto o item 10 do pedido (rota 100% leitura): `insert`/`update`/`delete`
 * e `.rpc()` LANÇAM se chamados, em vez de silenciosamente aceitar. Se
 * `getNfceDanfeData` algum dia ganhar um efeito colateral por engano,
 * qualquer teste aqui quebra imediatamente.
 */
function buildFakeAdmin(seed: { sales?: any[]; fiscal_documents?: any[]; fiscal_document_items?: any[] }) {
  const tables: Record<string, any[]> = {
    sales: seed.sales ?? [],
    fiscal_documents: seed.fiscal_documents ?? [],
    fiscal_document_items: seed.fiscal_document_items ?? [],
  }
  const readCalls: { table: string; filters: Record<string, unknown> }[] = []

  function from(table: string) {
    const filters: Record<string, unknown> = {}
    let ordered = false
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain },
      order: () => { ordered = true; return chain },
      insert: () => { throw new Error(`getNfceDanfeData nunca deve fazer INSERT em ${table} — rota é read-only (item 10/60 do pedido).`) },
      update: () => { throw new Error(`getNfceDanfeData nunca deve fazer UPDATE em ${table} — rota é read-only (item 10/60 do pedido).`) },
      delete: () => { throw new Error(`getNfceDanfeData nunca deve fazer DELETE em ${table} — rota é read-only (item 10/60 do pedido).`) },
      async maybeSingle() {
        readCalls.push({ table, filters: { ...filters } })
        const rows = (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
        return { data: rows[0] ?? null, error: null }
      },
      then(resolve: (v: any) => void) {
        readCalls.push({ table, filters: { ...filters } })
        const rows = (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
        resolve({ data: ordered ? [...rows].sort((a, b) => a.id - b.id) : rows, error: null })
      },
    }
    return chain
  }

  const client = {
    from,
    rpc: () => { throw new Error('getNfceDanfeData nunca deve chamar .rpc() — rota é read-only, nunca emite/transmite.') },
  }
  return { client, readCalls }
}

function seedAuthorizedNfce(overrides: {
  saleOverrides?: Partial<Record<string, unknown>>
  docOverrides?: Partial<Record<string, unknown>>
  items?: any[]
} = {}) {
  const context = baseFiscalContext({
    operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
    // Emitente/destinatário/pagamentos DELIBERADAMENTE diferentes de
    // qualquer "tabela viva" que um bug pudesse ler por engano — se um
    // teste passar mesmo com uma tabela viva teoricamente diferente, prova
    // que a fonte real é o snapshot, não a tabela viva (que nem é
    // mockada aqui).
    emitente: { ...baseFiscalContext().emitente, razaoSocial: 'Emitente Congelado no Snapshot LTDA', cnpj: '11222333000181' },
    destinatario: { ...baseFiscalContext().destinatario, nome: 'Consumidor Congelado', cpf: '11144477735', cnpj: null },
    payments: [{ method: 'pix', netAmount: 45, cardBrand: null, amountTendered: 45, changeAmount: 0 }, { method: 'cash', netAmount: 44.9, cardBrand: null, amountTendered: 50, changeAmount: 5.1 }],
  })

  const sale = { id: SALE_ID, company_id: COMPANY_ID, sale_number: 'SNT-0001', created_at: '2026-08-27T12:00:00Z', ...overrides.saleOverrides }
  const doc = {
    id: 501, sale_id: SALE_ID, company_id: COMPANY_ID, document_type: 'nfce', status: 'authorized',
    environment: 'homologacao', number: '12', series: '1',
    access_key: '41190612345678000123650010000000121743484310',
    authorization_protocol: '141190000123456',
    authorized_at: '2026-08-27T12:05:00Z',
    qrcode_url: 'http://hom.nfce.sefaz.rn.gov.br/portal/consultarNFCe.aspx?p=41190612345678000123650010000000121743484310',
    fiscal_context_snapshot: context,
    ...overrides.docOverrides,
  }
  const items = overrides.items ?? [
    { id: 1, fiscal_document_id: 501, description: 'Conjunto X', quantity: 2, unit: 'UN', unit_price: 45, discount_amount: 0, total_amount: 90 },
  ]

  return { sale, doc, items }
}

afterEach(() => { vi.restoreAllMocks() })

describe('getNfceDanfeData — caminho feliz', () => {
  it('devolve ok:true com dados vindos do snapshot congelado, não de tabelas ao vivo', async () => {
    const { sale, doc, items } = seedAuthorizedNfce()
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.emitente.razaoSocial).toBe('Emitente Congelado no Snapshot LTDA')
    expect(result.data.destinatario).toEqual({ nome: 'Consumidor Congelado', cpf: '11144477735', cnpj: null })
    expect(result.data.payments).toEqual([
      { method: 'pix', net_amount: 45, amount_tendered: 45, change_amount: 0 },
      { method: 'cash', net_amount: 44.9, amount_tendered: 50, change_amount: 5.1 },
    ])
    expect(result.data.items).toEqual([
      { description: 'Conjunto X', quantity: 2, unit: 'UN', unit_price: 45, discount_amount: 0, total_amount: 90 },
    ])
    expect(result.data.total).toBe(90)
    expect(result.data.fiscalDocument.qrcodeUrl).toBe(doc.qrcode_url)
    expect(result.data.fiscalDocument.accessKey).toBe(doc.access_key)
    expect(result.data.fiscalDocument.authorizationProtocol).toBe(doc.authorization_protocol)
  })

  it('total = soma de fiscal_document_items.total_amount (já inclui desconto/acréscimo ratados) — nunca recalculado de outra fonte', async () => {
    const { sale, doc } = seedAuthorizedNfce()
    const items = [
      { id: 1, fiscal_document_id: 501, description: 'Item A', quantity: 1, unit: 'UN', unit_price: 50, discount_amount: 5, total_amount: 45 },
      { id: 2, fiscal_document_id: 501, description: 'Item B', quantity: 3, unit: 'UN', unit_price: 10, discount_amount: 0, total_amount: 30 },
    ]
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.total).toBe(75)
  })

  it('consumidor não identificado (destinatário vazio no snapshot) → destinatario null', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({
      docOverrides: {
        fiscal_context_snapshot: baseFiscalContext({
          operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
          destinatario: { ...baseFiscalContext().destinatario, nome: null, cpf: null, cnpj: null, isAnonymous: true },
        }),
      },
    })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.destinatario).toBeNull()
  })
})

describe('getNfceDanfeData — item 10: leitura pura, nenhum efeito colateral', () => {
  it('nunca chama insert/update/delete/rpc — chamar 100 vezes produz sempre o mesmo resultado, 0 mutações', async () => {
    const { sale, doc, items } = seedAuthorizedNfce()
    const { client, readCalls } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const results = await Promise.all(Array.from({ length: 100 }, () => getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })))
    expect(results.every((r) => r.ok)).toBe(true)
    // Nenhuma chamada gravou nada — se tivesse, os `throw` dentro de
    // insert/update/delete/rpc já teriam derrubado o teste antes daqui.
    expect(readCalls.length).toBeGreaterThan(0)
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1) // sempre idêntico
  })
})

describe('getNfceDanfeData — item 11: isolamento multiempresa e status', () => {
  it('sale existe, mas em OUTRA empresa → not_found (usuário empresa A não vê venda da empresa B)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce()
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: 999, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('sale existe na empresa certa, mas fiscal_documents é de outra empresa → not_found (sale A nunca usa documento de sale B / company B)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { company_id: 999 } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('venda tem NF-e (document_type=nfe), não NFC-e → not_found, nunca renderiza NF-e como se fosse DANFE NFC-e', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { document_type: 'nfe' } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('NFC-e com status=validation_failed → not_found, nunca parece autorizada', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { status: 'validation_failed' } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('NFC-e com status=pending → not_found', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { status: 'pending' } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('NFC-e com status=cancelled → not_found, nunca parece uma NFC-e ativa', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { status: 'cancelled' } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('NFC-e com status=authorized → renderiza (ok:true)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce()
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
  })
})

describe('getNfceDanfeData — item 8: documento autorizado com dado local incompleto', () => {
  it('access_key ausente → ok:false reason:incomplete, lista o campo faltante, loga o erro', async () => {
    const { logError } = await import('@/lib/errors/log')
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { access_key: null } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') expect(result.missing).toContain('access_key')
    expect(logError).toHaveBeenCalled()
  })

  it('qrcode_url ausente → incomplete (nunca gera QR fictício nem renderiza sem QR silenciosamente)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { qrcode_url: null } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') expect(result.missing).toContain('qrcode_url')
  })

  it('authorization_protocol ausente → incomplete', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { authorization_protocol: null } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') expect(result.missing).toContain('authorization_protocol')
  })

  it('fiscal_context_snapshot ausente → incomplete (sem snapshot não há como saber emitente/destinatário/pagamentos congelados)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { fiscal_context_snapshot: null } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') expect(result.missing).toContain('fiscal_context_snapshot')
  })

  it('nenhum fiscal_document_items → incomplete (nunca um DANFE sem nenhum item)', async () => {
    const { sale, doc } = seedAuthorizedNfce()
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: [] })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') expect(result.missing).toContain('fiscal_document_items')
  })

  it('number/series ausentes → incomplete (cabeçalho do DANFE não pode mostrar null/null)', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { number: null, series: null } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'incomplete') {
      expect(result.missing).toContain('number')
      expect(result.missing).toContain('series')
    }
  })
})

describe('getNfceDanfeData — item 12: ambiente vem do campo estruturado, nunca de heurística de URL', () => {
  it('qrcode_url aponta pra hom.nfce.sefaz.rn.gov.br mas environment=producao → fiscalDocument.environment reflete o campo estruturado, não a URL', async () => {
    const { sale, doc, items } = seedAuthorizedNfce({ docOverrides: { environment: 'producao' } })
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result.ok).toBe(true)
    // A URL do QR continua sendo a de homologação (dado real, não alterado)
    // — mas o campo que decide o banner é `environment`, nunca um regex na URL.
    if (result.ok) {
      expect(result.data.fiscalDocument.qrcodeUrl).toContain('hom.nfce.sefaz.rn.gov.br')
      expect(result.data.fiscalDocument.environment).toBe('producao')
    }
  })

  it('environment=homologacao é preservado tal como veio da coluna, sem inferência', async () => {
    const { sale, doc, items } = seedAuthorizedNfce()
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [doc], fiscal_document_items: items })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.fiscalDocument.environment).toBe('homologacao')
  })
})

describe('getNfceDanfeData — fundação homologação↔produção (auditoria 2026-09-06, itens 17/18 da lista de testes)', () => {
  it('17) mesma venda com homologação E produção autorizadas → environment=homologacao explícito carrega SÓ a de homologação, sem lançar', async () => {
    const { sale, doc: docHomolog, items } = seedAuthorizedNfce({ docOverrides: { id: 501, environment: 'homologacao', access_key: '41190612345678000123650010000000121743484310' } })
    const docProducao = { ...docHomolog, id: 502, environment: 'producao', access_key: '41190612345678000123650010000000121743484399' }
    const itemsProducao = items.map((item: any) => ({ ...item, id: item.id + 100, fiscal_document_id: 502 }))
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [docHomolog, docProducao], fiscal_document_items: [...items, ...itemsProducao] })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fiscalDocument.environment).toBe('homologacao')
      expect(result.data.fiscalDocument.id).toBe(501)
    }
  })

  it('18) mesma venda com homologação E produção autorizadas → environment=producao explícito carrega SÓ a de produção, sem lançar', async () => {
    const { sale, doc: docHomolog, items } = seedAuthorizedNfce({ docOverrides: { id: 501, environment: 'homologacao', access_key: '41190612345678000123650010000000121743484310' } })
    const docProducao = { ...docHomolog, id: 502, environment: 'producao', access_key: '41190612345678000123650010000000121743484399' }
    const itemsProducao = items.map((item: any) => ({ ...item, id: item.id + 100, fiscal_document_id: 502 }))
    const { client } = buildFakeAdmin({ sales: [sale], fiscal_documents: [docHomolog, docProducao], fiscal_document_items: [...items, ...itemsProducao] })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client)

    const result = await getNfceDanfeData({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fiscalDocument.environment).toBe('producao')
      expect(result.data.fiscalDocument.id).toBe(502)
    }
  })
})

describe('formatAccessKey — 11 grupos de 4 dígitos, como no DANFE oficial', () => {
  it('44 dígitos válidos → agrupado com espaços', () => {
    const key = '41190612345678000123650010000000121743484310'
    expect(formatAccessKey(key)).toBe('4119 0612 3456 7800 0123 6500 1000 0000 1217 4348 4310')
  })

  it('null → null', () => {
    expect(formatAccessKey(null)).toBeNull()
  })

  it('valor com tamanho errado → devolve cru, nunca lança nem trunca', () => {
    expect(formatAccessKey('123')).toBe('123')
    expect(() => formatAccessKey('123')).not.toThrow()
  })

  it('valor não-numérico → devolve cru, nunca lança', () => {
    expect(formatAccessKey('NFe' + '1'.repeat(44))).toBe('NFe' + '1'.repeat(44))
  })
})
