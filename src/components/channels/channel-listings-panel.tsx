'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ExternalLink, Loader2, PauseCircle, PlayCircle, RefreshCw, Search, ShoppingBag, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import type { ChannelProductOverview, ListingView } from '@/services/channels/listings.service'
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
  draft: { label: 'Rascunho', variant: 'default' },
  closed: { label: 'Encerrado', variant: 'default' },
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
  const [publishing, setPublishing] = useState(false)

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
  const publishable = (data?.variations ?? []).filter((v) => !v.listing && v.manual_enabled && v.picture_count > 0)

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
            {connected && !publishing && publishable.length > 0 && (
              <Button size="sm" onClick={() => setPublishing(true)}>Publicar no Mercado Livre</Button>
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
                  <th className="py-2 pr-3">Mercado Livre</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.variations.map((v) => {
                  const l = v.listing
                  const st = l ? LOCAL_STATUS[l.local_status] ?? LOCAL_STATUS.draft : null
                  return (
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
                      <td className="py-2 pr-3">
                        {!l ? <span className="text-text-muted">Não publicado</span> : (
                          <div className="space-y-0.5">
                            <Badge variant={st!.variant}>{st!.label}</Badge>
                            {l.external_status && (
                              <p className="text-xs text-text-muted">
                                ML: {l.external_status}{l.external_sub_status.length ? ` (${l.external_sub_status.join(', ')})` : ''}
                              </p>
                            )}
                            <p className="text-xs text-text-muted">
                              {l.external_listing_id ?? '—'} · enviado {l.synced_quantity ?? '—'} un · {l.price != null ? formatCurrency(l.price) : '—'}
                            </p>
                            <p className="text-xs text-text-muted">Última sincronização: {fmtDate(l.last_synced_at)}</p>
                            {l.last_error && <p className="text-xs text-warning">{l.last_error}</p>}
                          </div>
                        )}
                      </td>
                      <td className="py-2">
                        {l && (
                          <div className="flex flex-wrap gap-1">
                            {l.external_listing_id ? (
                              <>
                                <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:sync`} onClick={() => action(l, 'sync')}>
                                  <RefreshCw className="h-3.5 w-3.5" /> Sincronizar
                                </Button>
                                {l.local_status === 'paused' ? (
                                  <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:activate`} onClick={() => action(l, 'activate')}>
                                    <PlayCircle className="h-3.5 w-3.5" /> Reativar
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:pause`} onClick={() => action(l, 'pause')}>
                                    <PauseCircle className="h-3.5 w-3.5" /> Pausar
                                  </Button>
                                )}
                                {l.permalink && (
                                  <a href={l.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-brand hover:bg-brand/10">
                                    <ExternalLink className="h-3.5 w-3.5" /> Abrir
                                  </a>
                                )}
                              </>
                            ) : (
                              <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `${l.id}:reconcile`} onClick={() => action(l, 'reconcile')}>
                                <Wrench className="h-3.5 w-3.5" /> Reconciliar
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {publishing && (
            <PublishFlow
              overview={data}
              candidates={publishable}
              onCancel={() => setPublishing(false)}
              onDone={async () => { setPublishing(false); await load() }}
            />
          )}
        </div>
      )}
    </section>
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

function PublishFlow({ overview, candidates, onCancel, onDone }: {
  overview: Overview
  candidates: ChannelProductOverview['variations']
  onCancel: () => void
  onDone: () => void
}) {
  const [query, setQuery] = useState(overview.product.name)
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([])
  const [category, setCategory] = useState<CategorySuggestion | null>(null)
  const [form, setForm] = useState<MercadoLivrePublishForm | null>(null)
  const [loadingForm, setLoadingForm] = useState(false)
  const [common, setCommon] = useState<Record<string, ChannelAttributeValue>>({})
  const [perVariation, setPerVariation] = useState<Record<number, Record<string, ChannelAttributeValue>>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set(candidates.map((c) => c.id)))
  const [prices, setPrices] = useState<Record<number, string>>({})
  const [familyName, setFamilyName] = useState(overview.product.name)
  const [description, setDescription] = useState('')
  const [listingType, setListingType] = useState('gold_special')
  const [submitting, setSubmitting] = useState(false)

  async function searchCategory() {
    const res = await fetch(`/api/integrations/mercadolivre/categories/search?q=${encodeURIComponent(query)}`)
    const json = await res.json()
    if (!res.ok) { toast.error(json.error); return }
    setSuggestions(json.suggestions ?? [])
  }

  useEffect(() => { searchCategory() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseCategory(s: CategorySuggestion) {
    setCategory(s)
    setLoadingForm(true)
    try {
      const res = await fetch(`/api/integrations/mercadolivre/categories/${s.category_id}?product_id=${overview.product.id}`)
      const json = await res.json()
      if (!res.ok) { toast.error(json.error); setCategory(null); return }
      const f = json as MercadoLivrePublishForm
      setForm(f)
      const c: Record<string, ChannelAttributeValue> = {}
      for (const a of [...s.suggested_attributes, ...f.suggestions.common]) {
        if (f.common_attributes.some((d) => d.id === a.id)) c[a.id] = a
      }
      setCommon(c)
      const pv: Record<number, Record<string, ChannelAttributeValue>> = {}
      for (const [vid, list] of Object.entries(f.suggestions.by_variation)) {
        pv[Number(vid)] = Object.fromEntries(list.map((a) => [a.id, a]))
      }
      setPerVariation(pv)
    } finally {
      setLoadingForm(false)
    }
  }

  const shownCommon = useMemo(() => (form?.common_attributes ?? []).filter((a) => a.required || a.new_required || a.conditional_required || !a.hidden).slice(0, 40), [form])
  const shownVariation = useMemo(() => (form?.variation_attributes ?? []).filter((a) => a.required || a.new_required || a.conditional_required || a.id === 'COLOR' || a.id === 'SIZE' || a.id === 'GTIN' || a.id === 'EMPTY_GTIN_REASON'), [form])

  async function submit() {
    if (!category || !form) return
    const variations = candidates.filter((v) => selected.has(v.id)).map((v) => ({
      product_variation_id: v.id,
      channel_price: prices[v.id] ? Number(prices[v.id].replace(',', '.')) : null,
      attributes: Object.values(perVariation[v.id] ?? {}),
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
          listing_type_id: listingType,
          family_name: familyName,
          description: description || null,
          common_attributes: Object.values(common),
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
      <h3 className="text-sm font-semibold">Publicar no Mercado Livre</h3>

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
                <select className="input-base mt-0.5 h-9 text-sm" value={listingType} onChange={(e) => setListingType(e.target.value)}>
                  <option value="gold_special">Clássico (gold_special)</option>
                  <option value="gold_pro">Premium (gold_pro)</option>
                </select>
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
                </label>
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="block text-xs text-text-muted">Preço no ML (vazio = {formatCurrency(v.price)})
                    <input className="input-base mt-0.5 h-9 text-sm" inputMode="decimal" value={prices[v.id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [v.id]: e.target.value }))} />
                  </label>
                  {shownVariation.map((def) => (
                    <AttributeInput key={def.id} def={def} value={perVariation[v.id]?.[def.id]}
                      onChange={(val) => setPerVariation((p) => ({ ...p, [v.id]: { ...(p[v.id] ?? {}), [def.id]: val } }))} />
                  ))}
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
            <Button onClick={submit} loading={submitting} disabled={selected.size === 0 || !familyName.trim()}>Publicar no Mercado Livre</Button>
          </div>
        </>
      )}
      {!form && <div className="flex justify-end"><Button variant="secondary" onClick={onCancel}>Cancelar</Button></div>}
    </div>
  )
}
