'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ExternalLink, Loader2, PauseCircle, PlayCircle, RefreshCw, Search, ShoppingBag, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import type { ChannelOfferView, ChannelProductOverview, ListingView } from '@/services/channels/listings.service'
import type { ChartCellValue, ChartTemplate, ChartTemplateAttribute, SizeChart, SizeChartSummary } from '@/lib/integrations/mercadolivre/sizeCharts'
import type { MercadoLivrePublishForm } from '@/services/channels/mercadolivreChannel'
import type { AttributeDefinition, CategorySuggestion } from '@/lib/integrations/mercadolivre/catalog'
import type { ChannelAttributeValue } from '@/lib/channels/types'

type Overview = ChannelProductOverview & {
  channels: { mercadolivre: { state: string; nickname: string | null; site_id: string | null; is_test_user: boolean } }
}

const LOCAL_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'error' | 'default' | 'info' }> = {
  active: { label: 'Publicado', variant: 'success' },
  paused: { label: 'Pausado', variant: 'warning' },
  publishing: { label: 'Publicando…', variant: 'info' },
  error: { label: 'Erro', variant: 'error' },
  draft: { label: 'Não publicado', variant: 'default' },
  closed: { label: 'Encerrado', variant: 'default' },
}

const STAGE_LABEL: Record<string, string> = {
  validate: 'reprovada na validação do ML',
  create_rejected: 'recusada pelo ML',
  create_unknown: 'sem confirmação do ML',
  reconcile: 'reconciliação',
}

function fmtDate(v: string | null) {
  return v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

/**
 * Detalhe do produto → Canais de venda → Mercado Livre.
 * A tela nunca recebe token nem composição de kit: só SKU, preço,
 * quantidade vendável (já resolvida pelo servidor) e o vínculo.
 */
export function ChannelListingsPanel({ productId }: { productId: number }) {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * null = fechado. variationIds vazio = todas as elegíveis. retry = "Publicar
   * novamente" de UMA oferta (mesma offer_key/tipo, pré-preenchida).
   */
  const [publishing, setPublishing] = useState<{ variationIds: number[]; retry?: ChannelOfferView } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/channels/listings?product_id=${productId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Falha ao carregar canais.')
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar canais.')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { load() }, [load])

  async function action(listing: ListingView, kind: 'sync' | 'pause' | 'activate' | 'reconcile') {
    setBusy(`${listing.id}:${kind}`)
    try {
      const res = await fetch(`/api/channels/listings/${listing.id}/${kind}`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Operação não concluída', { description: json.error })
      } else {
        toast.success(
          kind === 'sync' ? 'Anúncio sincronizado.' : kind === 'pause' ? 'Anúncio pausado.' :
          kind === 'activate' ? 'Anúncio reativado.' : json.result?.message ?? 'Reconciliação concluída.',
        )
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  const ml = data?.channels.mercadolivre
  const connected = ml?.state === 'connected'
  // Nova oferta: qualquer variação habilitada com imagem — uma variação pode
  // ter N ofertas (Clássico, Premium…) compartilhando o mesmo estoque.
  const eligible = (data?.variations ?? []).filter((v) => v.manual_enabled && v.picture_count > 0)

  return (
    <section className="card space-y-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><ShoppingBag className="h-5 w-5 text-brand" /> Canais de venda</h2>
      </header>

      {loading && <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</p>}
      {error && <p className="text-sm text-error">{error}</p>}

      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">Mercado Livre</span>
              {connected ? (
                <span className="text-xs text-text-muted">
                  Conta {ml?.nickname ?? '—'} · {ml?.site_id}
                  {ml?.is_test_user && <Badge variant="info" className="ml-2">TEST</Badge>}
                </span>
              ) : (
                <span className="text-xs text-text-muted">
                  {ml?.state === 'needs_reauth' ? 'Reautorização necessária.' : 'Não conectado.'}{' '}
                  <Link href="/configuracoes/mercadolivre" className="text-brand hover:underline">Configurar</Link>
                </span>
              )}
            </div>
            {connected && !publishing && eligible.length > 0 && (
              <Button size="sm" onClick={() => setPublishing({ variationIds: [] })}>Nova oferta no Mercado Livre</Button>
            )}
          </div>

          {connected && !ml?.is_test_user && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              Conta conectada não é usuário de TESTE: a publicação fica bloqueada no servidor até a homologação ser aprovada.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="py-2 pr-3">Variação</th>
                  <th className="py-2 pr-3">SKU</th>
                  <th className="py-2 pr-3">Preço</th>
                  <th className="py-2 pr-3">Disponível</th>
                  <th className="py-2 pr-3" colSpan={2}>Ofertas no Mercado Livre (mesmo estoque)</th>
                </tr>
              </thead>
              <tbody>
                {data.variations.map((v) => (
                  <tr key={v.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">
                      {[v.color, v.size].filter(Boolean).join(' / ') || '—'}
                      {v.is_kit && <Badge variant="outline" className="ml-2">Kit</Badge>}
                      {!v.manual_enabled && <span className="ml-2 text-xs text-warning">desativada</span>}
                      {v.picture_count === 0 && <p className="text-xs text-error">sem imagem JPG/PNG pública</p>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{v.sku}</td>
                    <td className="py-2 pr-3">{formatCurrency(v.price)}</td>
                    <td className="py-2 pr-3 tabular-nums">{v.sellable_quantity}</td>
                    <td className="py-2 pr-3" colSpan={2}>
                      <div className="space-y-2">
                        {v.listings.length === 0 && <span className="text-text-muted">Não publicado</span>}
                        {v.listings.map((l) => (
                          <OfferBlock key={l.id} offer={l} busy={busy}
                            canRepublish={!publishing && connected && v.manual_enabled && v.picture_count > 0}
                            onAction={action}
                            onRepublish={() => setPublishing({ variationIds: [v.id], retry: l })} />
                        ))}
                        {connected && !publishing && v.manual_enabled && v.picture_count > 0 && (
                          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setPublishing({ variationIds: [v.id] })}>
                            + Nova oferta
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {publishing && (
            <PublishFlow
              overview={data}
              retryOffer={publishing.retry ?? null}
              candidates={publishing.variationIds.length ? eligible.filter((v) => publishing.variationIds.includes(v.id)) : eligible}
              onCancel={() => setPublishing(null)}
              onDone={async () => { setPublishing(null); await load() }}
            />
          )}
        </div>
      )}
    </section>
  )
}

// ─── Uma oferta (anúncio) da variação ────────────────────────────────────────

const LISTING_TYPE_LABEL: Record<string, string> = { gold_special: 'Clássico', gold_pro: 'Premium' }

function OfferBlock({ offer: l, busy, canRepublish, onAction, onRepublish }: {
  offer: ChannelOfferView
  busy: string | null
  canRepublish: boolean
  onAction: (l: ListingView, kind: 'sync' | 'pause' | 'activate' | 'reconcile') => void
  onRepublish: () => void
}) {
  const st = LOCAL_STATUS[l.local_status] ?? LOCAL_STATUS.draft
  const typeLabel = l.listing_type_id ? (LISTING_TYPE_LABEL[l.listing_type_id] ?? l.listing_type_id) : null
  return (
    <div className="rounded-lg border border-border/70 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={st.variant}>{st.label}</Badge>
        {typeLabel && <span className="text-xs font-medium">{typeLabel}</span>}
        {l.offer_key !== l.listing_type_id && <span className="font-mono text-xs text-text-muted">{l.offer_key}</span>}
        <span className="text-xs tabular-nums">{formatCurrency(l.effective_price)}{l.channel_price != null ? ' (preço do canal)' : ''}</span>
      </div>
      {l.external_status && (
        <p className="text-xs text-text-muted">ML: {l.external_status}{l.external_sub_status.length ? ` (${l.external_sub_status.join(', ')})` : ''}</p>
      )}
      {l.external_listing_id && (
        <p className="text-xs text-text-muted">
          {l.external_listing_id} · enviado {l.synced_quantity ?? '—'} un · {l.price != null ? formatCurrency(l.price) : '—'} · sinc. {fmtDate(l.last_synced_at)}
        </p>
      )}
      {l.external_listing_id && l.last_error && <p className="text-xs text-warning">{l.last_error}</p>}
      {!l.external_listing_id && l.last_attempt && (
        <div className="mt-1 rounded-md bg-bg-overlay px-2 py-1 text-xs text-text-secondary">
          <p className="font-medium">Tentativa anterior ({fmtDate(l.last_attempt.at)}) — {STAGE_LABEL[l.last_attempt.stage] ?? l.last_attempt.stage}:</p>
          <p className="break-words">{l.last_attempt.error}</p>
          {l.attempt_outdated.length > 0 && (
            <p className="mt-0.5 text-info">Desde então: {l.attempt_outdated.join('; ')}. O erro acima pode não se aplicar mais.</p>
          )}
        </div>
      )}
      {!l.external_listing_id && l.last_error && l.last_error !== l.last_attempt?.error && <p className="text-xs text-text-muted">{l.last_error}</p>}
      <div className="mt-1 flex flex-wrap gap-1">
        {l.external_listing_id ? (
          <>
            <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:sync`} onClick={() => onAction(l, 'sync')}>
              <RefreshCw className="h-3.5 w-3.5" /> Sincronizar
            </Button>
            {l.local_status === 'paused' ? (
              <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:activate`} onClick={() => onAction(l, 'activate')}>
                <PlayCircle className="h-3.5 w-3.5" /> Reativar
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:pause`} onClick={() => onAction(l, 'pause')}>
                <PauseCircle className="h-3.5 w-3.5" /> Pausar
              </Button>
            )}
            {l.permalink && (
              <a href={l.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-brand hover:bg-brand/10">
                <ExternalLink className="h-3.5 w-3.5" /> Abrir
              </a>
            )}
          </>
        ) : l.can_publish ? (
          <Button size="sm" disabled={busy !== null || !canRepublish} onClick={onRepublish}>Publicar novamente</Button>
        ) : l.needs_reconciliation ? (
          <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:reconcile`} onClick={() => onAction(l, 'reconcile')}>
            <Wrench className="h-3.5 w-3.5" /> Reconciliar
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ─── Fluxo de publicação ─────────────────────────────────────────────────────

function AttributeInput({ def, value, onChange }: {
  def: AttributeDefinition
  value: ChannelAttributeValue | undefined
  onChange: (v: ChannelAttributeValue) => void
}) {
  const required = def.required || def.new_required
  const label = `${def.name}${required ? ' *' : def.conditional_required ? ' (condicional)' : ''}`
  if (def.value_type === 'list' || def.value_type === 'boolean') {
    return (
      <label className="block text-xs text-text-muted">
        {label}
        <select
          className="input-base mt-0.5 h-9 text-sm"
          value={value?.value_id ?? ''}
          onChange={(e) => {
            const opt = def.values.find((o) => o.id === e.target.value)
            onChange({ id: def.id, value_id: opt?.id ?? null, value_name: opt?.name ?? null })
          }}
        >
          <option value="">{value?.value_name && !value.value_id ? `${value.value_name} (texto)` : '—'}</option>
          {def.values.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    )
  }
  return (
    <label className="block text-xs text-text-muted">
      {label}{def.default_unit ? ` (${def.default_unit})` : ''}
      <input
        className="input-base mt-0.5 h-9 text-sm"
        maxLength={def.max_length ?? 255}
        value={value?.value_name ?? ''}
        onChange={(e) => onChange({ id: def.id, value_id: null, value_name: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
      />
    </label>
  )
}

function PublishFlow({ overview, candidates, retryOffer, onCancel, onDone }: {
  overview: Overview
  candidates: ChannelProductOverview['variations']
  /** "Publicar novamente" de uma oferta: mesma offer_key/tipo e dados da última tentativa. */
  retryOffer: ChannelOfferView | null
  onCancel: () => void
  onDone: () => void
}) {
  const previous = retryOffer?.previous_input ?? null
  const [query, setQuery] = useState(overview.product.name)
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([])
  const [category, setCategory] = useState<CategorySuggestion | null>(null)
  const [form, setForm] = useState<MercadoLivrePublishForm | null>(null)
  const [loadingForm, setLoadingForm] = useState(false)
  const [common, setCommon] = useState<Record<string, ChannelAttributeValue>>({})
  const [perVariation, setPerVariation] = useState<Record<number, Record<string, ChannelAttributeValue>>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set(candidates.map((c) => c.id)))
  const [prices, setPrices] = useState<Record<number, string>>({})
  const [familyName, setFamilyName] = useState(previous?.family_name ?? overview.product.name)
  const [description, setDescription] = useState(previous?.description ?? '')
  const [listingType, setListingType] = useState(retryOffer?.listing_type_id ?? previous?.listing_type_id ?? 'gold_special')
  // Identificador da oferta dentro da variação (vazio = o tipo de anúncio).
  const [offerKey, setOfferKey] = useState(retryOffer && retryOffer.offer_key !== retryOffer.listing_type_id ? retryOffer.offer_key : '')
  const effectiveOfferKey = (offerKey.trim().toLowerCase() || listingType).replace(/[^a-z0-9_-]+/g, '-')
  const offerTaken = (v: ChannelProductOverview['variations'][number]) =>
    v.listings.some((l) => l.offer_key === effectiveOfferKey && (l.external_listing_id != null || !l.can_publish) && l.id !== retryOffer?.id)
  const [submitting, setSubmitting] = useState(false)
  // Tabela de medidas (categorias de moda)
  const [charts, setCharts] = useState<SizeChartSummary[] | null>(null)
  const [chart, setChart] = useState<SizeChart | null>(null)
  const [rowByVariation, setRowByVariation] = useState<Record<number, string>>({})
  const [loadingCharts, setLoadingCharts] = useState(false)
  /** O ML informou que o domínio não usa tabela de medidas (domain_not_active): não bloqueia. */
  const [gridInactive, setGridInactive] = useState(false)
  const [creatingChart, setCreatingChart] = useState(false)

  async function searchCategory() {
    const res = await fetch(`/api/integrations/mercadolivre/categories/search?q=${encodeURIComponent(query)}`)
    const json = await res.json()
    if (!res.ok) { toast.error(json.error); return }
    setSuggestions(json.suggestions ?? [])
  }

  useEffect(() => {
    searchCategory()
    if (previous?.category_id) {
      chooseCategory({ category_id: previous.category_id, category_name: previous.category_id, domain_id: previous.domain_id, domain_name: null, suggested_attributes: [] })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseCategory(s: CategorySuggestion) {
    setCategory(s)
    setLoadingForm(true)
    try {
      const res = await fetch(`/api/integrations/mercadolivre/categories/${s.category_id}?product_id=${overview.product.id}`)
      const json = await res.json()
      if (!res.ok) { toast.error(json.error); setCategory(null); return }
      const f = json as MercadoLivrePublishForm
      setForm(f)
      setCategory((cur) => cur && cur.category_id === s.category_id ? { ...cur, category_name: f.category.name || cur.category_name } : cur)
      setCharts(null); setChart(null); setRowByVariation({}); setGridInactive(false)
      const isCommon = (id: string) => f.common_attributes.some((d) => d.id === id)
      const isVariation = (id: string) => f.variation_attributes.some((d) => d.id === id)
      const c: Record<string, ChannelAttributeValue> = {}
      for (const a of [...s.suggested_attributes, ...f.suggestions.common]) if (isCommon(a.id)) c[a.id] = a
      const pv: Record<number, Record<string, ChannelAttributeValue>> = {}
      for (const [vid, list] of Object.entries(f.suggestions.by_variation)) {
        pv[Number(vid)] = Object.fromEntries(list.map((a) => [a.id, a]))
      }
      // Valores da tentativa anterior (se mesma categoria) têm prioridade sobre as sugestões.
      for (const cand of candidates) {
        const prev = retryOffer && retryOffer.product_variation_id === cand.id ? retryOffer.previous_input : null
        if (!prev || prev.category_id !== s.category_id) continue
        for (const a of prev.attributes) {
          if (isCommon(a.id)) c[a.id] = a
          else if (isVariation(a.id)) pv[cand.id] = { ...(pv[cand.id] ?? {}), [a.id]: a }
        }
      }
      setCommon(c)
      setPerVariation(pv)
    } finally {
      setLoadingForm(false)
    }
  }

  const shownCommon = useMemo(() => (form?.common_attributes ?? []).filter((a) => a.required || a.new_required || a.conditional_required || !a.hidden).slice(0, 40), [form])
  const shownVariation = useMemo(() => (form?.variation_attributes ?? []).filter((a) => a.required || a.new_required || a.conditional_required || a.id === 'COLOR' || a.id === 'SIZE' || a.id === 'GTIN' || a.id === 'EMPTY_GTIN_REASON'), [form])

  const variationSize = (v: ChannelProductOverview['variations'][number]) =>
    (perVariation[v.id]?.SIZE?.value_name ?? v.size ?? '').toString()

  async function findCharts(): Promise<SizeChartSummary[] | null> {
    if (!form?.size_grid) return null
    const domainId = category?.domain_id
    if (!domainId) { toast.error('Domínio da categoria desconhecido: escolha a categoria pela sugestão.'); return null }
    setLoadingCharts(true)
    try {
      const res = await fetch('/api/integrations/mercadolivre/size-charts/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain_id: domainId, attributes: Object.values(common) }),
      })
      const json = await res.json()
      if (!res.ok) {
        if (/domain_not_active/.test(String(json.error ?? ''))) { setGridInactive(true); setCharts([]); return [] }
        toast.error('Tabela de medidas', { description: json.error }); return null
      }
      setGridInactive(false)
      setCharts(json.charts ?? [])
      return json.charts ?? []
    } finally {
      setLoadingCharts(false)
    }
  }

  async function chooseChart(id: string, preloaded?: SizeChart) {
    setChart(null); setRowByVariation({})
    if (!id) return
    let ch = preloaded
    if (!ch) {
      const res = await fetch(`/api/integrations/mercadolivre/size-charts/${id}`)
      const json = await res.json()
      if (!res.ok) { toast.error('Tabela de medidas', { description: json.error }); return }
      ch = json.chart as SizeChart
    }
    setChart(ch)
    // Casa o SIZE de cada variação com a linha da tabela (o ML exige igualdade).
    const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, '').replace(/,/g, '.')
    const auto: Record<number, string> = {}
    for (const v of candidates) {
      const size = variationSize(v)
      const hits = size ? ch.rows.filter((r) => r.sizes.some((x) => norm(x) === norm(size))) : []
      if (hits.length === 1) auto[v.id] = hits[0].id
    }
    setRowByVariation(auto)
  }

  /** Tabela recém-criada: busca de novo, seleciona automaticamente e casa as linhas. */
  async function onChartCreated(created: SizeChart) {
    setCreatingChart(false)
    toast.success(`Tabela de medidas ${created.id} criada com ${created.rows.length} tamanho(s).`)
    const list = (await findCharts()) ?? []
    if (!list.some((c) => c.id === created.id)) {
      setCharts([{ id: created.id, name: created.name, type: created.type, main_attribute_id: created.main_attribute_id }, ...list])
    }
    await chooseChart(created.id, created)
  }

  const gridMissing = form?.size_grid && !gridInactive
    ? (!chart ? ['tabela'] : candidates.filter((v) => selected.has(v.id) && !rowByVariation[v.id]).map((v) => v.sku))
    : []

  async function submit() {
    if (!category || !form) return
    const grid = form.size_grid
    const variations = candidates.filter((v) => selected.has(v.id)).map((v) => ({
      product_variation_id: v.id,
      channel_price: prices[v.id] ? Number(prices[v.id].replace(',', '.')) : null,
      attributes: [
        ...Object.values(perVariation[v.id] ?? {}).filter((a) => !grid || a.id !== grid.row_attribute_id),
        ...(grid && rowByVariation[v.id] ? [{ id: grid.row_attribute_id, value_name: rowByVariation[v.id] }] : []),
      ],
    }))
    if (variations.length === 0) { toast.error('Selecione ao menos uma variação.'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/channels/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'mercadolivre',
          product_id: overview.product.id,
          category_id: category.category_id,
          domain_id: category.domain_id ?? null,
          listing_type_id: listingType,
          offer_key: offerKey.trim() ? effectiveOfferKey : null,
          family_name: familyName,
          description: description || null,
          common_attributes: [
            ...Object.values(common).filter((a) => !grid || a.id !== grid.grid_attribute_id),
            ...(grid && chart ? [{ id: grid.grid_attribute_id, value_name: chart.id }] : []),
          ],
          variations,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error('Não foi possível publicar', { description: json.error }); return }
      const results = (json.results ?? []) as Array<{ status: string; message?: string; productVariationId: number }>
      const ok = results.filter((r) => r.status === 'published' || r.status === 'reconciled').length
      const bad = results.filter((r) => r.status === 'failed' || r.status === 'skipped')
      if (ok) toast.success(`${ok} variação(ões) publicada(s) no Mercado Livre.`)
      for (const r of bad) toast.error(`Variação #${r.productVariationId}`, { description: r.message })
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-brand/30 p-4">
      <h3 className="text-sm font-semibold">{retryOffer ? `Publicar novamente — oferta ${retryOffer.offer_key}` : 'Nova oferta no Mercado Livre'}</h3>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase text-text-muted">1. Categoria</p>
        <div className="flex gap-2">
          <input className="input-base h-9 text-sm" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchCategory() } }} aria-label="Buscar categoria" />
          <Button size="sm" variant="secondary" onClick={searchCategory}><Search className="h-4 w-4" /> Sugerir</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s.category_id} type="button" onClick={() => chooseCategory(s)}
              className={`rounded-lg border px-3 py-1.5 text-xs ${category?.category_id === s.category_id ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-bg-overlay'}`}>
              {s.category_name} <span className="text-text-muted">({s.category_id})</span>
            </button>
          ))}
        </div>
        {form && <p className="text-xs text-text-muted">{form.category.path.map((p) => p.name).join(' › ')}</p>}
      </div>

      {loadingForm && <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Carregando atributos da categoria…</p>}

      {form && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-text-muted">2. Dados do anúncio</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-text-muted">Nome do produto (família) *
                <input className="input-base mt-0.5 h-9 text-sm" maxLength={form.category.max_title_length} value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
              </label>
              <label className="block text-xs text-text-muted">Tipo de anúncio
                <select className="input-base mt-0.5 h-9 text-sm" value={listingType} disabled={retryOffer != null} onChange={(e) => setListingType(e.target.value)}>
                  <option value="gold_special">Clássico (gold_special)</option>
                  <option value="gold_pro">Premium (gold_pro)</option>
                </select>
              </label>
              <label className="block text-xs text-text-muted">Identificador da oferta (opcional)
                <input className="input-base mt-0.5 h-9 text-sm" placeholder={listingType} maxLength={60} value={offerKey}
                  disabled={retryOffer != null} onChange={(e) => setOfferKey(e.target.value)} />
                <span>Use para ter duas ofertas do mesmo tipo (ex.: promo-4190). Todas compartilham o estoque da variação.</span>
              </label>
            </div>
            <label className="block text-xs text-text-muted">Descrição
              <textarea className="input-base mt-0.5 min-h-20 text-sm" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={form.category.max_description_length ?? 50000} />
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-text-muted">3. Atributos da categoria</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {shownCommon.map((def) => (
                <AttributeInput key={def.id} def={def} value={common[def.id]} onChange={(v) => setCommon((c) => ({ ...c, [def.id]: v }))} />
              ))}
            </div>
          </div>

          {form.size_grid && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase text-text-muted">Tabela de medidas (exigida pela categoria)</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => { findCharts() }} loading={loadingCharts}>Buscar tabelas</Button>
                {charts && charts.length > 0 && (
                  <select className="input-base h-9 max-w-md text-sm" value={chart?.id ?? ''} onChange={(e) => chooseChart(e.target.value)} aria-label="Tabela de medidas">
                    <option value="">Escolha a tabela…</option>
                    {charts.map((c) => <option key={c.id} value={c.id}>{c.name || c.id} ({c.type ?? '—'})</option>)}
                  </select>
                )}
              </div>
              {gridInactive && <p className="text-xs text-text-muted">O Mercado Livre informou que este domínio não usa tabela de medidas — pode publicar sem ela.</p>}
              {charts && charts.length === 0 && !gridInactive && !creatingChart && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-warning">Nenhuma tabela encontrada.</p>
                  <Button size="sm" onClick={() => setCreatingChart(true)}>Criar tabela de medidas</Button>
                </div>
              )}
              {charts && charts.length > 0 && !creatingChart && (
                <button type="button" className="text-xs text-brand hover:underline" onClick={() => setCreatingChart(true)}>Criar outra tabela de medidas</button>
              )}
              {creatingChart && category?.domain_id && (
                <CreateSizeChartForm
                  domainId={category.domain_id}
                  productName={familyName || overview.product.name}
                  commonValues={Object.values(common)}
                  sizes={[...new Set(candidates.filter((v) => selected.has(v.id)).map(variationSize).filter(Boolean))]}
                  onCancel={() => setCreatingChart(false)}
                  onCreated={onChartCreated}
                />
              )}
              {!charts && <p className="text-xs text-text-muted">Preencha os atributos da categoria (ex.: gênero e marca) e busque as tabelas disponíveis para esta conta.</p>}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-text-muted">4. Variações ({candidates.length})</p>
            {candidates.map((v) => (
              <div key={v.id} className="space-y-2 rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.has(v.id)}
                    onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(v.id); else n.delete(v.id); return n })} />
                  <span className="font-mono text-xs">{v.sku}</span>
                  <span>{[v.color, v.size].filter(Boolean).join(' / ')}</span>
                  <span className="text-text-muted">· qtd {v.sellable_quantity} · {v.picture_count} imagem(ns)</span>
                  {offerTaken(v) && <span className="text-xs text-warning">já tem a oferta “{effectiveOfferKey}” — será ignorada</span>}
                </label>
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="block text-xs text-text-muted">Preço no ML (vazio = {formatCurrency(v.price)})
                    <input className="input-base mt-0.5 h-9 text-sm" inputMode="decimal" value={prices[v.id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [v.id]: e.target.value }))} />
                  </label>
                  {shownVariation.map((def) => (
                    <AttributeInput key={def.id} def={def} value={perVariation[v.id]?.[def.id]}
                      onChange={(val) => setPerVariation((p) => ({ ...p, [v.id]: { ...(p[v.id] ?? {}), [def.id]: val } }))} />
                  ))}
                  {chart && (
                    <label className="block text-xs text-text-muted">Linha da tabela *
                      <select className="input-base mt-0.5 h-9 text-sm" value={rowByVariation[v.id] ?? ''}
                        onChange={(e) => setRowByVariation((r) => ({ ...r, [v.id]: e.target.value }))}>
                        <option value="">—</option>
                        {chart.rows.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                      {rowByVariation[v.id] && !chart.rows.find((r) => r.id === rowByVariation[v.id])?.sizes.some((x) => x.trim().toUpperCase() === variationSize(v).trim().toUpperCase()) && (
                        <span className="text-warning">O tamanho da variação ({variationSize(v) || '—'}) difere da linha escolhida; o ML exige que coincidam.</span>
                      )}
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg bg-bg-overlay p-3 text-xs text-text-secondary">
            Conta <strong>{overview.channels.mercadolivre.nickname}</strong>{overview.channels.mercadolivre.is_test_user ? ' (TEST)' : ''} ·
            categoria <strong>{category?.category_name}</strong> · {selected.size} variação(ões). O SKU enviado é o da variação vendável
            e a quantidade é a disponibilidade atual calculada pelo Qarvon.
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={submitting}>Cancelar</Button>
            <Button onClick={submit} loading={submitting} disabled={selected.size === 0 || !familyName.trim() || gridMissing.length > 0}>Publicar no Mercado Livre</Button>
          </div>
          {gridMissing.length > 0 && (
            <p className="text-right text-xs text-warning">
              {chart ? `Escolha a linha da tabela para: ${gridMissing.join(', ')}.` : 'Escolha a tabela de medidas antes de publicar.'}
            </p>
          )}
        </>
      )}
      {!form && <div className="flex justify-end"><Button variant="secondary" onClick={onCancel}>Cancelar</Button></div>}
    </div>
  )
}

// ─── Criação de tabela de medidas (SPECIFIC) ─────────────────────────────────

function ChartCellInput({ def, value, onChange }: {
  def: ChartTemplateAttribute
  value: ChartCellValue | undefined
  onChange: (v: ChartCellValue) => void
}) {
  if (def.values.length > 0 && (def.value_type === 'list' || def.value_type === 'boolean')) {
    return (
      <select className="input-base h-8 text-xs" aria-label={def.name} value={value?.value_id ?? ''}
        onChange={(e) => { const o = def.values.find((x) => x.id === e.target.value); onChange({ value_id: o?.id ?? null, value_name: o?.name ?? null }) }}>
        <option value="">—</option>
        {def.values.map((o) => <option key={o.id || o.name} value={o.id}>{o.name}</option>)}
      </select>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <input className="input-base h-8 text-xs" aria-label={def.name}
        inputMode={def.value_type === 'number_unit' ? 'decimal' : undefined}
        value={value?.value_name ?? ''} onChange={(e) => onChange({ value_name: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} />
      {def.value_type === 'number_unit' && def.default_unit && <span className="text-xs text-text-muted">{def.default_unit}</span>}
    </div>
  )
}

/**
 * Formulário DINÂMICO: campos gerais, atributo principal, tipo de medida e
 * colunas das linhas vêm da ficha técnica da tabela do domínio. Linhas
 * iniciais = tamanhos das variações selecionadas (P, M, G, GG…).
 */
function CreateSizeChartForm({ domainId, productName, commonValues, sizes, onCancel, onCreated }: {
  domainId: string
  productName: string
  commonValues: ChannelAttributeValue[]
  sizes: string[]
  onCancel: () => void
  onCreated: (chart: SizeChart) => void
}) {
  const [template, setTemplate] = useState<ChartTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [measureType, setMeasureType] = useState<string | null>(null)
  const [mainId, setMainId] = useState('')
  const [general, setGeneral] = useState<Record<string, ChartCellValue>>({})
  const [rows, setRows] = useState<Array<Record<string, ChartCellValue>>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch('/api/integrations/mercadolivre/size-charts/template', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain_id: domainId, attributes: commonValues }),
        })
        const json = await res.json()
        if (!alive) return
        if (!res.ok) { setError(json.error ?? 'Falha ao ler a ficha da tabela.'); return }
        const t = json.template as ChartTemplate
        setTemplate(t)
        setMeasureType(t.measure_types[0] ?? null)
        const main = t.main_attribute_candidates.find((a) => a.value_type === 'string') ?? t.main_attribute_candidates[0]
        setMainId(main?.id ?? '')
        const byId = new Map(commonValues.map((a) => [a.id, a]))
        setGeneral(Object.fromEntries(t.chart_attributes.map((d) => [d.id, { value_id: byId.get(d.id)?.value_id ?? null, value_name: byId.get(d.id)?.value_name ?? null }])))
        // nome sugerido: produto + valor do filtro obrigatório da ficha (ex.: gênero)
        const tmplAttr = t.chart_attributes.find((d) => d.tags.includes('grid_template_required'))
        const tmplValue = tmplAttr ? byId.get(tmplAttr.id)?.value_name : null
        setName([productName, tmplValue].filter(Boolean).join(' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60))
        const initial = sizes.length ? sizes : ['P', 'M', 'G', 'GG']
        setRows(initial.map((sz) => (main ? { [main.id]: { value_name: sz } } : {})))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const main = template?.main_attribute_candidates.find((a) => a.id === mainId)
  const rowDefs = template ? template.row_attributes.filter((a) => !a.measure_type || !measureType || a.measure_type === measureType) : []

  function setCell(i: number, id: string, v: ChartCellValue) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [id]: v } : r)))
  }

  function changeMain(id: string) {
    // mantém os tamanhos digitados ao trocar o atributo principal
    setRows((rs) => rs.map((r) => { const cur = mainId ? r[mainId] : undefined; const { [mainId]: _old, ...rest } = r; return cur ? { ...rest, [id]: cur } : rest }))
    setMainId(id)
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/mercadolivre/size-charts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain_id: domainId, name, measure_type: measureType, main_attribute_id: mainId,
          attributes: Object.entries(general).map(([id, v]) => ({ id, value_id: v.value_id ?? null, value_name: v.value_name ?? null })),
          rows,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error('Não foi possível criar a tabela', { description: json.error }); return }
      onCreated(json.chart as SizeChart)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Criar tabela de medidas (específica desta conta)</p>
      {loading && <p className="flex items-center gap-2 text-xs text-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lendo a ficha técnica da tabela…</p>}
      {error && <p className="text-xs text-error">{error}</p>}
      {template && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs text-text-muted">Nome da tabela * (até 60, sem símbolos)
              <input className="input-base mt-0.5 h-9 text-sm" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {template.measure_types.length > 0 && (
              <label className="block text-xs text-text-muted">Tipo de medida *
                <select className="input-base mt-0.5 h-9 text-sm" value={measureType ?? ''} onChange={(e) => setMeasureType(e.target.value || null)}>
                  {template.measure_types.map((m) => <option key={m} value={m}>{m === 'BODY_MEASURE' ? 'Medidas do corpo' : 'Medidas da peça'}</option>)}
                </select>
              </label>
            )}
            <label className="block text-xs text-text-muted">Atributo principal (tamanho) *
              <select className="input-base mt-0.5 h-9 text-sm" value={mainId} onChange={(e) => changeMain(e.target.value)}>
                {template.main_attribute_candidates.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {template.chart_attributes.map((def) => (
              <label key={def.id} className="block text-xs text-text-muted">
                {def.name}{def.tags.includes('required') || def.tags.includes('grid_template_required') ? ' *' : ''}
                <ChartCellInput def={def} value={general[def.id]} onChange={(v) => setGeneral((g) => ({ ...g, [def.id]: v }))} />
              </label>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-1 pr-2">{main?.name ?? 'Tamanho'} *</th>
                  {rowDefs.map((d) => <th key={d.id} className="py-1 pr-2">{d.name} *</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">{main && <ChartCellInput def={main} value={r[main.id]} onChange={(v) => setCell(i, main.id, v)} />}</td>
                    {rowDefs.map((d) => <td key={d.id} className="py-1 pr-2"><ChartCellInput def={d} value={r[d.id]} onChange={(v) => setCell(i, d.id, v)} /></td>)}
                    <td><button type="button" className="text-error hover:underline" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>remover</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setRows((rs) => [...rs, {}])}>+ tamanho</button>
          </div>

          <p className="text-xs text-text-muted">O tamanho de cada variação precisa ser idêntico ao tamanho da linha (o Mercado Livre confere na publicação).</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={save} loading={saving} disabled={!name.trim() || !mainId || rows.length === 0}>Criar tabela</Button>
          </div>
        </>
      )}
      {!template && !loading && <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={onCancel}>Fechar</Button></div>}
    </div>
  )
}
