import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { runPeriodicListingReconcile, describeExternalStatus, type PeriodicReconcileDeps, type ReconcileRepo } from './listingsReconcile.service'
import { ListingError, toListingView, type ChannelContext, type ListingRow } from './listings.service'
import { createMercadoLivreAdapter } from '@/lib/integrations/mercadolivre/adapter'
import { setMercadoLivreLogSink } from '@/lib/integrations/mercadolivre/log'
import { FakeMlDb, TEST_CONFIG, setTestCipherEnv } from '@/lib/integrations/mercadolivre/fakeMercadoLivre.testutil'
import { FakeMlMarket } from '@/lib/integrations/mercadolivre/fakeMlMarket.testutil'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const OTHER = 20

/** Mesma semântica da RPC 202609271000 (claim com idade mínima) + trava otimista em updated_at. */
class MemoryReconcileRepo implements ReconcileRepo {
  rows: ListingRow[] = []
  tick = 0
  now = () => Date.now()
  beforeUpdate: (() => void) | null = null
  async claim(limit: number, minAgeSeconds: number) {
    const due = this.rows
      .filter((r) => (r.local_status === 'active' || r.local_status === 'paused') && r.external_listing_id
        && (!r.last_reconciled_at || this.now() - new Date(r.last_reconciled_at).getTime() >= Math.max(minAgeSeconds, 60) * 1000))
      .sort((a, b) => (a.last_reconciled_at ?? '').localeCompare(b.last_reconciled_at ?? '') || a.id - b.id)
      .slice(0, limit)
    for (const r of due) Object.assign(r, { last_reconciled_at: new Date(this.now()).toISOString(), updated_at: `v${++this.tick}` })
    return due.map((r) => structuredClone(r))
  }
  async updateGuarded(companyId: number, id: number, expected: string | undefined, patch: Partial<ListingRow>) {
    this.beforeUpdate?.()
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    if (!r || (expected && r.updated_at !== expected)) return false
    Object.assign(r, patch, { updated_at: `v${++this.tick}` })
    return true
  }
}

let db: FakeMlDb
let api: FakeMlMarket
let repo: MemoryReconcileRepo
let integrationId: number
let itemSeq = 0

function channel(): ChannelContext {
  return { provider: 'mercadolivre', integrationId, companyId: COMPANY, sellerId: String(api.me.id), siteId: 'MLB', currencyId: 'BRL', model: 'user_products', accountLabel: 'LOJA_TESTE', isTestAccount: true }
}

function deps(over: Partial<PeriodicReconcileDeps> = {}): PeriodicReconcileDeps {
  return {
    repo,
    resolveChannel: async (companyId: number) => {
      if (companyId !== COMPANY) throw new ListingError('not_connected', 'Mercado Livre não conectado.')
      return channel()
    },
    adapterFor: (ctx: ChannelContext) => createMercadoLivreAdapter({
      integrationId: ctx.integrationId, companyId: ctx.companyId, sellerId: ctx.sellerId, model: 'user_products',
      deps: { config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} },
    }),
    ...over,
  }
}

function mkItem(over: Partial<{ price: number; available_quantity: number; status: string; sub_status: string[]; seller_id: number; listing_type_id: string }> = {}) {
  const id = `MLB${9000 + ++itemSeq}`
  api.items.set(id, {
    id, seller_id: over.seller_id ?? api.me.id, category_id: 'MLB1234', price: over.price ?? 49.9, currency_id: 'BRL',
    available_quantity: over.available_quantity ?? 5, status: over.status ?? 'active', sub_status: over.sub_status ?? [],
    title: 'Sutiã Renda TESTE', family_name: 'Sutiã Renda', user_product_id: `MLBU${itemSeq}`, family_id: 77,
    attributes: [{ id: 'SELLER_SKU', value_name: `SKU-${itemSeq}` }], pictures: [{ source: 'x.jpg' }],
    permalink: `https://produto.mercadolivre.com.br/${id}`, description: null, listing_type_id: over.listing_type_id ?? 'gold_special',
  })
  return id
}

function mkRow(externalId: string, over: Partial<ListingRow> = {}): ListingRow {
  const row: ListingRow = {
    id: repo.rows.length + 1, company_id: COMPANY, integration_id: integrationId, provider: 'mercadolivre', product_id: 1,
    product_variation_id: 11, seller_sku: 'SUT-PRETO-M', offer_key: 'gold_special', listing_type_id: 'gold_special',
    external_listing_id: externalId, external_variant_id: null, external_product_id: null, external_group_id: null,
    external_ids: {}, external_category_id: 'MLB1234', external_status: 'active', external_sub_status: [], permalink: null,
    local_status: 'active', channel_price: null, last_sent_price: 49.9, synced_quantity: 5, last_synced_at: null,
    last_error: null, publish_lease_until: null, metadata: {}, last_reconciled_at: null, last_reconcile_error: null, updated_at: 'v0',
    ...over,
  }
  repo.rows.push(row)
  return row
}

const writes = () => api.calls.filter((c) => c.method !== 'GET')
const itemReads = () => api.calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname.startsWith('/items'))
const row = (id: number) => repo.rows.find((r) => r.id === id)!

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlMarket()
  const pair = api.issue()
  integrationId = db.seedConnected(COMPANY, String(api.me.id), { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  repo = new MemoryReconcileRepo()
  setMercadoLivreLogSink(() => {})
})
afterEach(() => setMercadoLivreLogSink(null))

describe('reconciliação periódica canal → Qarvon (somente leitura)', () => {
  it('C1. preço alterado no ML → preço próprio externo (mesma regra do sync), histórico, nenhuma escrita no canal', async () => {
    const id = mkItem({ price: 8 })
    const r = mkRow(id)
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res).toMatchObject({ claimed: 1, reconciled: 1, changed: 1, failed: 0 })
    expect(writes()).toHaveLength(0)
    expect(row(r.id)).toMatchObject({ channel_price: 8, last_sent_price: 49.9, last_reconcile_error: null })
    expect(row(r.id).last_reconciled_at).toEqual(expect.any(String))
    expect(row(r.id).metadata).toMatchObject({ price_source: 'external', last_seen_external_price: 8 })
    const hist = row(r.id).metadata.price_history as Array<Record<string, unknown>>
    expect(hist).toEqual([expect.objectContaining({ previous: 49.9, requested: 8, result: 'external_change', source: 'external' })])
    expect(toListingView(row(r.id))).toMatchObject({ price_mode: 'own', reconcile_divergences: [expect.objectContaining({ code: 'external_price' })] })
    // rodar de novo (após a idade mínima) não duplica o histórico
    repo.now = () => Date.now() + 2 * 3600_000
    await runPeriodicListingReconcile({}, deps())
    expect((row(r.id).metadata.price_history as unknown[])).toHaveLength(1)
    expect(toListingView(row(r.id)).reconcile_divergences).toEqual([])
  })

  it('C2. preço igual ao conhecido → oferta continua herdando; oferta com preço próprio do Qarvon não muda', async () => {
    const a = mkRow(mkItem({ price: 49.9 }))
    const b = mkRow(mkItem({ price: 39.9 }), { channel_price: 39.9, last_sent_price: 39.9 })
    await runPeriodicListingReconcile({}, deps())
    expect(row(a.id).channel_price).toBeNull()
    expect(row(b.id).channel_price).toBe(39.9)
    expect(row(a.id).metadata.price_history).toBeUndefined()
    expect(writes()).toHaveLength(0)
  })

  it('C3. pausa externa (paused_by_seller) reflete localmente; reativação externa também — sem "corrigir" o canal', async () => {
    const paused = mkRow(mkItem({ status: 'paused', sub_status: ['paused_by_seller'] }))
    const reactivated = mkRow(mkItem({ status: 'active' }), { local_status: 'paused', external_status: 'paused', external_sub_status: ['paused_by_seller'] })
    await runPeriodicListingReconcile({}, deps())
    expect(row(paused.id)).toMatchObject({ local_status: 'paused', external_status: 'paused', external_sub_status: ['paused_by_seller'] })
    expect(row(reactivated.id)).toMatchObject({ local_status: 'active', external_status: 'active' })
    expect(toListingView(row(paused.id))).toMatchObject({ external_status_reason: 'pausado (pausado pelo vendedor)', reconcile_divergences: [expect.objectContaining({ code: 'status_external' })] })
    expect(writes()).toHaveLength(0)
  })

  it('C4. pausa por falta de estoque (ML) não vira pausa manual local', async () => {
    const r = mkRow(mkItem({ status: 'paused', sub_status: ['out_of_stock'], available_quantity: 0 }), { synced_quantity: 0 })
    await runPeriodicListingReconcile({}, deps())
    expect(row(r.id)).toMatchObject({ local_status: 'active', external_status: 'paused', external_sub_status: ['out_of_stock'] })
    expect(toListingView(row(r.id)).reconcile_divergences).toEqual([])
  })

  it('C5. anúncio fechado no ML → closed local; moderado → mantém local, divergência com o motivo', async () => {
    const closed = mkRow(mkItem({ status: 'closed', sub_status: ['expired'] }))
    const moderated = mkRow(mkItem({ status: 'under_review', sub_status: ['waiting_for_patch'] }))
    await runPeriodicListingReconcile({}, deps())
    expect(row(closed.id)).toMatchObject({ local_status: 'closed', external_status: 'closed' })
    expect(toListingView(row(closed.id)).reconcile_divergences).toEqual([expect.objectContaining({ code: 'closed_external' })])
    expect(row(moderated.id)).toMatchObject({ local_status: 'active', external_status: 'under_review', external_sub_status: ['waiting_for_patch'] })
    const view = toListingView(row(moderated.id))
    expect(view.external_status_reason).toBe('em revisão pelo Mercado Livre (aguardando correção (moderação))')
    expect(view.reconcile_divergences).toEqual([expect.objectContaining({ code: 'moderation' })])
    // fechado não entra mais nos próximos lotes
    repo.now = () => Date.now() + 2 * 3600_000
    const again = await runPeriodicListingReconcile({}, deps())
    expect(again.claimed).toBe(1)
    expect(writes()).toHaveLength(0)
  })

  it('C6. quantidade, ids externos e tipo de anúncio observados; divergência de quantidade só sinalizada', async () => {
    const r = mkRow(mkItem({ available_quantity: 3, listing_type_id: 'gold_pro' }), { synced_quantity: 5 })
    await runPeriodicListingReconcile({}, deps())
    expect(row(r.id)).toMatchObject({ synced_quantity: 5, listing_type_id: 'gold_pro', external_product_id: expect.stringMatching(/^MLBU/), permalink: expect.stringContaining(r.external_listing_id!) })
    const view = toListingView(row(r.id))
    expect(view.observed_quantity).toBe(3)
    expect(view.reconcile_divergences.map((d) => d.code).sort()).toEqual(['listing_type', 'quantity'])
    expect(writes()).toHaveLength(0)
  })

  it('C7. erro individual (404) não interrompe os outros; erro gravado só no anúncio afetado', async () => {
    const ok1 = mkRow(mkItem({ price: 8 }))
    const missing = mkRow('MLB404404')
    const ok2 = mkRow(mkItem())
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res).toMatchObject({ claimed: 3, reconciled: 2, failed: 1 })
    expect(row(missing.id).last_reconcile_error).toMatch(/não encontrado no canal \(404\)/)
    expect(row(ok1.id)).toMatchObject({ channel_price: 8, last_reconcile_error: null })
    expect(row(ok2.id).last_reconcile_error).toBeNull()
    expect(toListingView(row(missing.id)).last_reconcile_error).toMatch(/404/)
  })

  it('C8. falha de transporte do canal para uma empresa → erro nos anúncios dela, sem exceção no job', async () => {
    const r = mkRow(mkItem())
    api.overrides.push({ match: (m, u) => m === 'GET' && u.pathname === '/items', response: () => new Response('{"message":"boom"}', { status: 503 }) })
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res).toMatchObject({ reconciled: 0, failed: 1 })
    expect(row(r.id).last_reconcile_error).toMatch(/503|retryable|boom/)
  })

  it('C9. tenant crossover: item de OUTRA conta nunca atualiza o anúncio; empresa sem canal não usa o canal de outra', async () => {
    const foreign = mkRow(mkItem({ seller_id: 999999, price: 1 }))
    const otherCompany = mkRow(mkItem({ price: 2 }), { company_id: OTHER })
    const staleIntegration = mkRow(mkItem({ price: 3 }), { integration_id: integrationId + 100 })
    const mine = mkRow(mkItem({ price: 8 }))
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res).toMatchObject({ claimed: 4, reconciled: 1, failed: 3 })
    expect(row(foreign.id)).toMatchObject({ channel_price: null, external_status: 'active' })
    expect(row(foreign.id).last_reconcile_error).toMatch(/outra conta/)
    expect(row(otherCompany.id)).toMatchObject({ channel_price: null })
    expect(row(otherCompany.id).last_reconcile_error).toMatch(/Canal indisponível/)
    expect(row(staleIntegration.id).last_reconcile_error).toMatch(/não está mais conectada/)
    expect(row(mine.id).channel_price).toBe(8)
    // só os itens da empresa conectada foram lidos (nenhum id da outra empresa/integração no multiget)
    const ids = itemReads().flatMap((c) => (new URL(c.url).searchParams.get('ids') ?? '').split(','))
    expect(ids).not.toContain(otherCompany.external_listing_id)
    expect(ids).not.toContain(staleIntegration.external_listing_id)
  })

  it('C10. token expirado é renovado de forma transparente (refresh com lease existente)', async () => {
    db.integrations[0].credential_expires_at = new Date(Date.now() - 1000).toISOString()
    const r = mkRow(mkItem({ price: 8 }))
    const res = await runPeriodicListingReconcile({}, deps())
    expect(api.refreshCalls).toBe(1)
    expect(res).toMatchObject({ reconciled: 1, failed: 0 })
    expect(row(r.id).channel_price).toBe(8)
  })

  it('C11. lotes: 25 anúncios → 2 leituras em lote (multiget de 20); idade mínima evita reler logo em seguida', async () => {
    for (let i = 0; i < 25; i++) mkRow(mkItem())
    const res = await runPeriodicListingReconcile({ limit: 100 }, deps())
    expect(res.reconciled).toBe(25)
    expect(itemReads()).toHaveLength(2)
    const again = await runPeriodicListingReconcile({ limit: 100 }, deps())
    expect(again.claimed).toBe(0)
    expect(itemReads()).toHaveLength(2)
    expect(writes()).toHaveLength(0)
  })

  it('C12. limite do lote respeitado; os mais antigos (nunca reconciliados) primeiro', async () => {
    for (let i = 0; i < 5; i++) mkRow(mkItem())
    repo.rows[0].last_reconciled_at = new Date(Date.now() - 5 * 3600_000).toISOString()
    const res = await runPeriodicListingReconcile({ limit: 3 }, deps())
    expect(res.claimed).toBe(3)
    expect(repo.rows.slice(1, 4).every((r) => r.last_reconcile_error === null && r.metadata.reconcile)).toBe(true)
    expect(repo.rows[0].metadata.reconcile).toBeUndefined()
  })

  it('C13. concorrência: sync/edição no meio → não sobrescreve (trava otimista); próxima rodada reconcilia', async () => {
    const r = mkRow(mkItem({ price: 8 }))
    repo.beforeUpdate = () => { row(r.id).updated_at = 'changed-by-sync'; repo.beforeUpdate = null }
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res).toMatchObject({ reconciled: 0, skipped_concurrent: 1 })
    expect(row(r.id).channel_price).toBeNull()
  })

  it('C14. anúncios sem id externo ou em rascunho/erro/fechados não entram', async () => {
    mkRow('MLB1', { local_status: 'closed' })
    mkRow('MLB2', { local_status: 'error' })
    mkRow(null as unknown as string, { local_status: 'active', external_listing_id: null })
    const res = await runPeriodicListingReconcile({}, deps())
    expect(res.claimed).toBe(0)
    expect(api.calls).toHaveLength(0)
  })

  it('describeExternalStatus: texto do status com motivo', () => {
    expect(describeExternalStatus('paused', ['out_of_stock'])).toBe('pausado (sem estoque)')
    expect(describeExternalStatus(null, [])).toBeNull()
    expect(describeExternalStatus('active', [])).toBe('ativo')
  })
})
