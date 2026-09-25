'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Globe, RefreshCw, Package, RotateCcw,
  CheckCircle2, XCircle, AlertCircle, Loader2, ChevronDown, ChevronUp,
  Layers, StopCircle, SearchCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type SyncEvent =
  | { type: 'start';   total: number }
  | { type: 'product'; status: 'ok';        name: string; product_id: number; variants_mapped: number; stock_total: number; images_sent?: number; warning?: string }
  | { type: 'product'; status: 'error';     name: string; product_id: number; error: string }
  | { type: 'product'; status: 'no_variants'; name: string; product_id: number }
  | { type: 'product'; status: 'skipped';   name: string; product_id: number; reason: string }
  | { type: 'variant'; status: 'ok';        variation_id: number; index: number; new_qty: number }
  | { type: 'variant'; status: 'error';     variation_id: number; index: number; error: string }
  | { type: 'variant'; status: 'skipped';   variation_id: number; index: number }
  | { type: 'done'; synced: number; errors: number; no_variants?: number; skipped?: number; total: number }
  | { type: 'error';   message: string }

type NsStatus = {
  total_products: number
  inconsistent?:  number
  not_published?: number
  total_variants: number
  last_synced_at: string | null
}

type PublicationState = 'not_published' | 'published' | 'inconsistent'

type PublicationItem = {
  id:                number
  name:              string
  state:             PublicationState
  remote_product_id: string | null
  active_variations: number
  mapped_variations: number
  stock_total:       number
}

type ReconcileResult = {
  ok:                    boolean
  error?:                string
  checked?:              number
  valid?:                number
  remote_deleted?:       number
  inconsistent_variants?: number
  remote_unlinked?:      number
  errors?:               number
  details?: {
    remote_deleted:        Array<{ product_id: number; remote_product_id: string }>
    inconsistent_variants: Array<{ product_id: number; product_variation_id: number; remote_product_id: string; remote_variant_id: string }>
    remote_unlinked:       Array<{ remote_product_id: string; name: string; skus: string[] }>
    errors:                Array<{ product_id?: number; remote_product_id?: string; error: string }>
  }
}

const STATE_LABEL: Record<PublicationState, string> = {
  not_published: 'Não publicado',
  published:     'Publicado',
  inconsistent:  'Inconsistente',
}

const STATE_CLASS: Record<PublicationState, string> = {
  not_published: 'bg-bg-overlay text-text-secondary border-border',
  published:     'bg-success/10 text-success border-success/20',
  inconsistent:  'bg-warning/10 text-warning border-warning/20',
}

// ─── Hook: stream SSE via fetch ───────────────────────────────────────────────

function useStreamSync() {
  const [loading, setLoading]   = useState(false)
  const [events, setEvents]     = useState<SyncEvent[]>([])

  const run = useCallback(async (url: string, body?: object) => {
    setLoading(true)
    setEvents([])

    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body ?? {}),
      })

      if (!res.ok || !res.body) {
        setEvents([{ type: 'error', message: `HTTP ${res.status}` }])
        return
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as SyncEvent
            setEvents((prev) => [...prev, event])
          } catch { /* JSON inválido, ignorar */ }
        }
      }
    } catch (err) {
      setEvents((prev) => [...prev, { type: 'error', message: String(err) }])
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, events, run }
}

// ─── Componente de log ────────────────────────────────────────────────────────

function SyncLog({ events, loading }: { events: SyncEvent[]; loading: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  if (!loading && events.length === 0) return null

  return (
    <div className="mt-4 rounded-xl bg-bg-base border border-border font-mono text-xs overflow-y-auto max-h-60 p-3 space-y-0.5">
      {events.map((ev, i) => {
        if (ev.type === 'start') {
          return (
            <div key={i} className="text-text-muted">
              Iniciando sync de {ev.total} item(s)...
            </div>
          )
        }

        if (ev.type === 'product') {
          if (ev.status === 'ok') {
            return (
              <div key={i} className="flex gap-2 text-success">
                <span className="flex-shrink-0">✓</span>
                <span>
                  {ev.name} — {ev.variants_mapped} variação(ões) · estoque: {ev.stock_total}
                  {ev.images_sent != null ? ` · ${ev.images_sent} imagem(ns)` : ''}
                  {ev.warning ? <span className="block text-warning">{ev.warning}</span> : null}
                </span>
              </div>
            )
          }
          if (ev.status === 'error') {
            return (
              <div key={i} className="flex gap-2 text-error">
                <span className="flex-shrink-0">✗</span>
                <span>{ev.name} — {ev.error}</span>
              </div>
            )
          }
          if (ev.status === 'skipped') {
            return (
              <div key={i} className="flex gap-2 text-text-muted">
                <span className="flex-shrink-0">—</span>
                <span>{ev.name} — {ev.reason}</span>
              </div>
            )
          }
          return (
            <div key={i} className="flex gap-2 text-warning">
              <span className="flex-shrink-0">—</span>
              <span>{ev.name} — sem variações ativas</span>
            </div>
          )
        }

        if (ev.type === 'variant') {
          if (ev.status === 'ok') {
            return (
              <div key={i} className="flex gap-2 text-success">
                <span className="flex-shrink-0">✓</span>
                <span>Variação #{ev.variation_id} — estoque: {ev.new_qty}</span>
              </div>
            )
          }
          if (ev.status === 'error') {
            return (
              <div key={i} className="flex gap-2 text-error">
                <span className="flex-shrink-0">✗</span>
                <span>Variação #{ev.variation_id} — {ev.error}</span>
              </div>
            )
          }
          return (
            <div key={i} className="text-text-muted">
              — Variação #{ev.variation_id} — sem mapeamento
            </div>
          )
        }

        if (ev.type === 'done') {
          return (
            <div key={i} className="border-t border-border pt-2 mt-1 text-text-primary font-semibold">
              Concluído — {ev.synced} ok
              {ev.errors    ? ` · ${ev.errors} erro(s)` : ''}
              {ev.no_variants ? ` · ${ev.no_variants} sem variações` : ''}
              {ev.skipped   ? ` · ${ev.skipped} ignorado(s)` : ''}
            </div>
          )
        }

        if (ev.type === 'error') {
          return (
            <div key={i} className="text-error font-semibold">
              Erro: {ev.message}
            </div>
          )
        }

        return null
      })}

      {loading && (
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Processando...</span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

// ─── Resultado da verificação ─────────────────────────────────────────────────

function ReconcileSummary({ result }: { result: ReconcileResult | null }) {
  if (!result) return null
  if (!result.ok) {
    return (
      <div className="mb-4 rounded-lg bg-error/5 border border-error/20 p-3 text-xs text-error">
        Verificação falhou: {result.error} — nenhum vínculo foi alterado.
      </div>
    )
  }
  const d = result.details
  return (
    <div className="mb-4 rounded-xl bg-bg-base border border-border p-3 space-y-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
        <span>Verificados: <b className="text-text-primary">{result.checked}</b></span>
        <span>Válidos: <b className="text-success">{result.valid}</b></span>
        <span>Excluídos na Nuvemshop: <b className="text-warning">{result.remote_deleted}</b></span>
        <span>Variantes inconsistentes: <b className="text-warning">{result.inconsistent_variants}</b></span>
        <span>Na Nuvemshop sem vínculo: <b className="text-text-primary">{result.remote_unlinked}</b></span>
        <span>Erros: <b className={result.errors ? 'text-error' : 'text-text-primary'}>{result.errors}</b></span>
      </div>
      {(d?.remote_deleted.length ?? 0) > 0 && (
        <p className="text-text-muted">
          Vínculos removidos (produto voltou a &quot;Não publicado&quot;): {d!.remote_deleted.map((r) => `#${r.product_id}`).join(', ')}
        </p>
      )}
      {(d?.remote_unlinked.length ?? 0) > 0 && (
        <details className="text-text-muted">
          <summary className="cursor-pointer">Produtos na Nuvemshop sem vínculo no ERP (não importados)</summary>
          <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto font-mono">
            {d!.remote_unlinked.map((r) => (
              <li key={r.remote_product_id}>ID {r.remote_product_id} — {r.name}{r.skus.length ? ` · ${r.skus.join(', ')}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {(d?.errors.length ?? 0) > 0 && (
        <ul className="text-error font-mono space-y-0.5">
          {d!.errors.map((e, i) => <li key={i}>{e.product_id ? `#${e.product_id}: ` : ''}{e.error}</li>)}
        </ul>
      )}
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function NuvemshopIntegration() {
  const [status, setStatus]               = useState<NsStatus | null>(null)
  const [items, setItems]                 = useState<PublicationItem[]>([])
  const [reconciling, setReconciling]     = useState(false)
  const [reconcile, setReconcile]         = useState<ReconcileResult | null>(null)
  const [selectedIds, setSelectedIds]     = useState<Set<number>>(new Set())
  const [showSelector, setShowSelector]   = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(true)

  // Batch stock sync state
  const [batchRunning, setBatchRunning]   = useState(false)
  const [batchDone, setBatchDone]         = useState(false)
  const [batchProgress, setBatchProgress] = useState({ processed: 0, success: 0, failed: 0, invalidated: 0, remaining: null as number | null })
  const [batchErrors, setBatchErrors]     = useState<Array<{ variation_id: number; error: string }>>([])
  const batchStopRef                      = useRef(false)

  const productSync = useStreamSync()
  const stockSync   = useStreamSync()

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      const res  = await fetch('/api/integrations/nuvemshop/status')
      const data = await res.json()
      setStatus(data)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  const fetchUnmapped = useCallback(async () => {
    const res  = await fetch('/api/integrations/nuvemshop/products/unmapped')
    const data = await res.json()
    if (Array.isArray(data.items)) {
      setItems(data.items)
      setSelectedIds(new Set(
        (data.items as PublicationItem[]).filter((p) => p.state === 'not_published').map((p) => p.id)
      ))
    }
  }, [])

  // Produtos que pedem ação: não publicados + inconsistentes (estoque não filtra).
  const unmapped = items.filter((p) => p.state !== 'published')
  const notPublishedCount = items.filter((p) => p.state === 'not_published').length
  const inconsistentCount = items.filter((p) => p.state === 'inconsistent').length

  useEffect(() => {
    fetchStatus()
    fetchUnmapped()
  }, [fetchStatus, fetchUnmapped])

  // Atualiza status após sync concluir
  useEffect(() => {
    if (!productSync.loading && productSync.events.some((e) => e.type === 'done')) {
      fetchStatus()
      fetchUnmapped()
    }
  }, [productSync.loading, productSync.events, fetchStatus, fetchUnmapped])

  const toggleProduct = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedIds.size === unmapped.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(unmapped.map((p) => p.id)))
    }
  }

  const handleSyncAll = () => {
    productSync.run('/api/integrations/nuvemshop/products/sync-stream')
  }

  const handleSyncSelected = () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    productSync.run('/api/integrations/nuvemshop/products/sync-stream', { productIds: ids })
  }

  const handleReconcile = async () => {
    setReconciling(true)
    setReconcile(null)
    try {
      const res  = await fetch('/api/integrations/nuvemshop/products/reconcile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      const data = await res.json() as ReconcileResult
      setReconcile(res.ok ? data : { ok: false, error: data.error ?? `HTTP ${res.status}` })
    } catch (err) {
      setReconcile({ ok: false, error: String(err) })
    } finally {
      setReconciling(false)
      fetchStatus()
      fetchUnmapped()
    }
  }

  const handleSyncStock = () => {
    stockSync.run('/api/integrations/nuvemshop/stock/sync-stream')
  }

  const handleBatchSyncStock = async () => {
    batchStopRef.current = false
    setBatchRunning(true)
    setBatchDone(false)
    setBatchProgress({ processed: 0, success: 0, failed: 0, invalidated: 0, remaining: null })
    setBatchErrors([])

    let cursor = 0
    try {
      while (!batchStopRef.current) {
        const res  = await fetch('/api/integrations/nuvemshop/stock/sync-batch', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ limit: 25, cursor }),
        })
        const data = await res.json()

        if (!res.ok || !data.ok) {
          setBatchErrors((prev) => [...prev, { variation_id: 0, error: data.error ?? `HTTP ${res.status}` }])
          break
        }

        setBatchProgress((prev) => ({
          processed: prev.processed + (data.processed ?? 0),
          success:   prev.success   + (data.success   ?? 0),
          failed:    prev.failed    + (data.failed     ?? 0),
          invalidated: prev.invalidated + (data.invalidated ?? 0),
          remaining: data.remaining_unsynced,
        }))

        if (data.errors?.length > 0) {
          setBatchErrors((prev) => [...prev, ...data.errors])
        }

        // Término garantido: o cursor só avança; `done` quando não há mais lote.
        if (data.done || data.processed === 0) {
          setBatchDone(true)
          break
        }
        cursor = data.next_cursor

        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (err) {
      setBatchErrors((prev) => [...prev, { variation_id: 0, error: String(err) }])
    } finally {
      setBatchRunning(false)
      fetchStatus()
    }
  }

  const handleStopBatch = () => {
    batchStopRef.current = true
  }

  const formatDate = (iso: string | null) => {
    if (!iso) return 'Nunca'
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const anyLoading = productSync.loading || stockSync.loading || batchRunning || reconciling

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/configuracoes"
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Nuvemshop</h2>
            <p className="text-sm text-text-muted">Integração com a loja online</p>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card padding="md" className="flex items-center gap-3">
          <Package className="w-5 h-5 text-brand flex-shrink-0" />
          <div>
            <p className="text-xs text-text-muted">Produtos publicados</p>
            {loadingStatus ? (
              <div className="h-5 w-8 bg-bg-overlay rounded animate-pulse mt-0.5" />
            ) : (
              <p className="text-lg font-bold text-text-primary">
                {status?.total_products ?? 0}
                {(status?.inconsistent ?? 0) > 0 && (
                  <span className="ml-2 text-xs font-medium text-warning">{status?.inconsistent} inconsistente(s)</span>
                )}
              </p>
            )}
          </div>
        </Card>

        <Card padding="md" className="flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
          <div>
            <p className="text-xs text-text-muted">Variações mapeadas</p>
            {loadingStatus ? (
              <div className="h-5 w-8 bg-bg-overlay rounded animate-pulse mt-0.5" />
            ) : (
              <p className="text-lg font-bold text-text-primary">{status?.total_variants ?? 0}</p>
            )}
          </div>
        </Card>

        <Card padding="md" className="flex items-center gap-3">
          <RefreshCw className="w-5 h-5 text-text-muted flex-shrink-0" />
          <div>
            <p className="text-xs text-text-muted">Último sync de estoque</p>
            {loadingStatus ? (
              <div className="h-5 w-24 bg-bg-overlay rounded animate-pulse mt-0.5" />
            ) : (
              <p className="text-sm font-medium text-text-primary">{formatDate(status?.last_synced_at ?? null)}</p>
            )}
          </div>
        </Card>
      </div>

      {/* Seção: Sync de Produtos */}
      <Card>
        <CardHeader className="gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Sincronizar Produtos</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Publica produtos ativos não publicados na Nuvemshop como ocultos, com estoque atual.
              {notPublishedCount > 0 && (
                <span className="ml-1 text-brand font-medium">{notPublishedCount} não publicado(s).</span>
              )}
              {inconsistentCount > 0 && (
                <span className="ml-1 text-warning font-medium">{inconsistentCount} inconsistente(s).</span>
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleReconcile}
            disabled={anyLoading}
            loading={reconciling}
          >
            <SearchCheck className="w-3.5 h-3.5" />
            Verificar produtos
          </Button>
        </CardHeader>

        <CardContent>
          <ReconcileSummary result={reconcile} />

          {unmapped.length === 0 && !productSync.loading && productSync.events.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="w-4 h-4" />
              Todos os produtos ativos estão publicados na Nuvemshop.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={handleSyncAll}
                  disabled={anyLoading || notPublishedCount === 0}
                  loading={productSync.loading}
                  size="sm"
                >
                  <Package className="w-3.5 h-3.5" />
                  Publicar não publicados{notPublishedCount > 0 ? ` (${notPublishedCount})` : ''}
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSyncSelected}
                  disabled={anyLoading || selectedIds.size === 0}
                >
                  Publicar / reparar selecionados ({selectedIds.size})
                </Button>

                {unmapped.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSelector((v) => !v)}
                    disabled={productSync.loading}
                  >
                    {showSelector ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {showSelector ? 'Ocultar lista' : 'Selecionar produtos'}
                  </Button>
                )}
              </div>

              {/* Seletor de produtos */}
              {showSelector && unmapped.length > 0 && (
                <div className="mt-3 border border-border rounded-xl overflow-hidden">
                  <div
                    className="flex items-center gap-2 px-3 py-2 bg-bg-overlay border-b border-border cursor-pointer hover:bg-bg-hover transition-colors"
                    onClick={toggleAll}
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={selectedIds.size === unmapped.length}
                      onChange={toggleAll}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-xs font-medium text-text-secondary">
                      {selectedIds.size === unmapped.length ? 'Desmarcar todos' : 'Marcar todos'}
                    </span>
                    <span className="ml-auto text-[10px] text-text-muted">{selectedIds.size}/{unmapped.length}</span>
                  </div>

                  <div className="overflow-y-auto max-h-48">
                    {unmapped.map((product) => (
                      <div
                        key={product.id}
                        className="flex items-center gap-2 px-3 py-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-bg-hover transition-colors"
                        onClick={() => toggleProduct(product.id)}
                      >
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={selectedIds.has(product.id)}
                          onChange={() => toggleProduct(product.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="text-xs text-text-primary">{product.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATE_CLASS[product.state]}`}>
                          {STATE_LABEL[product.state]}
                          {product.state === 'inconsistent' ? ` · ${product.mapped_variations}/${product.active_variations} variações` : ''}
                        </span>
                        {product.stock_total <= 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-muted">Sem estoque</span>
                        )}
                        <span className="ml-auto text-[10px] text-text-muted">#{product.id}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <SyncLog events={productSync.events} loading={productSync.loading} />
            </>
          )}
        </CardContent>
      </Card>

      {/* Seção: Sync de Estoque */}
      <Card>
        <CardHeader>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Sincronizar Estoque</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Força a atualização do estoque de todas as variações mapeadas na Nuvemshop.
              O estoque é sincronizado automaticamente a cada entrada ou ajuste no ERP.
            </p>
          </div>
        </CardHeader>

        <CardContent>
          <div className="flex items-start gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSyncStock}
              disabled={anyLoading}
              loading={stockSync.loading}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Forçar Sync de Estoque
            </Button>

            {!stockSync.loading && stockSync.events.length === 0 && (
              <div className="flex items-center gap-1.5 text-xs text-text-muted pt-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Use apenas se suspeitar de divergência entre ERP e Nuvemshop.
              </div>
            )}
          </div>

          <SyncLog events={stockSync.events} loading={stockSync.loading} />
        </CardContent>
      </Card>

      {/* Seção: Sync de Estoque em Lotes */}
      <Card>
        <CardHeader>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Sincronizar Estoque Pendente</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Processa 25 variações por vez sem manter conexão aberta. Sincroniza variações que ainda não foram enviadas ao site (sem data de sync), uma passada por execução. Para reenviar tudo, use o botão acima.
            </p>
          </div>
        </CardHeader>

        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={handleBatchSyncStock}
              disabled={anyLoading}
              loading={batchRunning}
            >
              <Layers className="w-3.5 h-3.5" />
              {batchRunning ? 'Sincronizando...' : 'Sincronizar Pendentes em Lotes'}
            </Button>

            {batchRunning && (
              <Button variant="secondary" size="sm" onClick={handleStopBatch}>
                <StopCircle className="w-3.5 h-3.5" />
                Parar
              </Button>
            )}
          </div>

          {/* Progresso */}
          {(batchRunning || batchDone || batchProgress.processed > 0) && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="rounded-lg bg-bg-overlay border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Processadas</p>
                  <p className="text-lg font-bold text-text-primary">{batchProgress.processed}</p>
                </div>
                <div className="rounded-lg bg-bg-overlay border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Sucesso</p>
                  <p className="text-lg font-bold text-success">{batchProgress.success}</p>
                </div>
                <div className="rounded-lg bg-bg-overlay border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Falhas</p>
                  <p className="text-lg font-bold text-error">{batchProgress.failed}</p>
                </div>
                <div className="rounded-lg bg-bg-overlay border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Vínculos removidos</p>
                  <p className="text-lg font-bold text-warning">{batchProgress.invalidated}</p>
                </div>
                <div className="rounded-lg bg-bg-overlay border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Restantes</p>
                  <p className="text-lg font-bold text-text-primary">
                    {batchProgress.remaining === null ? '—' : batchProgress.remaining}
                  </p>
                </div>
              </div>

              {batchDone && batchProgress.remaining === 0 && (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="w-4 h-4" />
                  Todas as variações sincronizadas com sucesso.
                </div>
              )}

              {batchDone && (batchProgress.remaining ?? 0) > 0 && (
                <div className="flex items-center gap-2 text-sm text-warning">
                  <AlertCircle className="w-4 h-4" />
                  Concluído. {batchProgress.remaining} variação(ões) seguem pendentes por falha — veja os erros abaixo.
                </div>
              )}

              {!batchRunning && !batchDone && batchProgress.processed > 0 && (
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <StopCircle className="w-4 h-4" />
                  Sincronização interrompida. {batchProgress.remaining ?? '?'} variações restantes.
                </div>
              )}

              {batchErrors.length > 0 && (
                <div className="rounded-lg bg-error/5 border border-error/20 p-3 space-y-1 max-h-40 overflow-y-auto">
                  <p className="text-xs font-semibold text-error mb-1">
                    {batchErrors.length} erro(s) encontrado(s):
                  </p>
                  {batchErrors.map((e, i) => (
                    <div key={i} className="text-xs text-error font-mono">
                      {e.variation_id > 0 ? `Variação #${e.variation_id}: ` : ''}{e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info box */}
      <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-brand/5 border border-brand/15">
        <CheckCircle2 className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
        <div className="text-xs text-text-secondary space-y-0.5">
          <p><span className="font-medium text-text-primary">Sync automático ativo:</span> toda entrada ou ajuste de estoque no ERP atualiza a Nuvemshop em tempo real.</p>
          <p><span className="font-medium text-text-primary">Pedidos online:</span> pedidos pagos na Nuvemshop são criados automaticamente no ERP com origem <code className="text-brand">site</code>.</p>
        </div>
      </div>
    </div>
  )
}
