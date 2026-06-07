'use client'

export const dynamic = 'force-dynamic'

import { useState, useMemo, useCallback, useTransition } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Link from 'next/link'
import {
  ArrowLeft, Search, Package, CheckCircle2,
  AlertTriangle, TrendingUp, TrendingDown, Minus,
  ClipboardList, RotateCcw, Save, ChevronDown, ChevronUp,
} from 'lucide-react'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { formatNumber } from '@/lib/utils/currency'
import type { InventarioItemInput } from '@/app/api/estoque/inventario/route'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface StockItem {
  product_variation_id: number
  product_name:         string
  sku_variation:        string | null
  sku_parent:           string | null
  tamanho:              string | null
  cor:                  string | null
  current_qty:          number
}

interface CountState {
  [pvid: number]: string  // valor digitado (string para suportar campo vazio)
}

type SummaryView = {
  positive: Array<StockItem & { delta: number; counted: number }>
  negative: Array<StockItem & { delta: number; counted: number }>
  unchanged: number
  total_counted: number
  total_adjusted: number
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function InventarioFisicoPage() {
  const supabase = createClient()

  const [search,        setSearch]        = useState('')
  const [counts,        setCounts]        = useState<CountState>({})
  const [expanded,      setExpanded]      = useState<Set<number>>(new Set())
  const [showSummary,   setShowSummary]   = useState(false)
  const [saving,        startSaving]      = useTransition()
  const [savedResults,  setSavedResults]  = useState<{
    applied: number; errors: number
  } | null>(null)

  // ── Carregar itens do estoque ──────────────────────────────────────────────
  const { data: items = [], isLoading } = useQuery<StockItem[]>({
    queryKey: ['inventario-estoque'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('vw_stock_live')
        .select(
          'product_variation_id, product_name, sku_variation, sku_parent, tamanho, cor, current_qty'
        )
        .order('product_name')
        .order('tamanho')
        .order('cor')

      if (error) throw error
      return (data ?? []) as StockItem[]
    },
    staleTime: 30_000,
  })

  // ── Filtro de busca ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(
      (i) =>
        i.product_name.toLowerCase().includes(q)  ||
        (i.sku_variation ?? '').toLowerCase().includes(q) ||
        (i.sku_parent    ?? '').toLowerCase().includes(q) ||
        (i.tamanho       ?? '').toLowerCase().includes(q) ||
        (i.cor           ?? '').toLowerCase().includes(q)
    )
  }, [items, search])

  // ── Helpers de estado ──────────────────────────────────────────────────────
  const getCountedQty = (pvid: number): number | null => {
    const raw = counts[pvid]
    if (raw === undefined || raw === '') return null
    const parsed = parseInt(raw, 10)
    return isNaN(parsed) ? null : parsed
  }

  const getDelta = (item: StockItem): number | null => {
    const counted = getCountedQty(item.product_variation_id)
    if (counted === null) return null
    return counted - item.current_qty
  }

  const toggleExpanded = (pvid: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(pvid) ? next.delete(pvid) : next.add(pvid)
      return next
    })
  }

  const resetItem = (pvid: number) => {
    setCounts((prev) => { const n = { ...prev }; delete n[pvid]; return n })
    setExpanded((prev) => { const n = new Set(prev); n.delete(pvid); return n })
  }

  // ── Resumo antes de salvar ─────────────────────────────────────────────────
  const summary = useMemo<SummaryView>(() => {
    const positive: SummaryView['positive'] = []
    const negative: SummaryView['negative'] = []
    let unchanged = 0
    let total_counted = 0
    let total_adjusted = 0

    for (const item of items) {
      const counted = getCountedQty(item.product_variation_id)
      if (counted === null) continue
      total_counted++
      const delta = counted - item.current_qty
      if (delta > 0) {
        positive.push({ ...item, delta, counted })
        total_adjusted++
      } else if (delta < 0) {
        negative.push({ ...item, delta, counted })
        total_adjusted++
      } else {
        unchanged++
      }
    }

    positive.sort((a, b) => b.delta - a.delta)
    negative.sort((a, b) => a.delta - b.delta)

    return { positive, negative, unchanged, total_counted, total_adjusted }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, counts])

  // ── Salvar inventário ──────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const toSend: InventarioItemInput[] = []

    for (const item of items) {
      const delta = getDelta(item)
      if (delta !== null && delta !== 0) {
        toSend.push({ product_variation_id: item.product_variation_id, delta })
      }
    }

    if (toSend.length === 0) {
      toast.info('Nenhum ajuste com delta diferente de zero.')
      return
    }

    startSaving(async () => {
      const res = await fetch('/api/estoque/inventario', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: toSend }),
      })

      const json = await res.json()

      if (!res.ok && res.status !== 207) {
        toast.error(json.error ?? 'Erro ao salvar inventário.')
        return
      }

      setSavedResults({ applied: json.applied, errors: json.errors })
      setShowSummary(false)

      if (json.errors > 0) {
        toast.warning(`${json.applied} ajustes salvos, ${json.errors} com erro.`)
      } else {
        toast.success(`Inventário salvo: ${json.applied} ajuste${json.applied !== 1 ? 's' : ''} aplicado${json.applied !== 1 ? 's' : ''}.`)
        setCounts({})
        setExpanded(new Set())
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, counts])

  // ── Contagem de itens tocados ──────────────────────────────────────────────
  const touchedCount = Object.keys(counts).filter(
    (k) => counts[Number(k)] !== ''
  ).length

  const deltaCount   = summary.positive.length + summary.negative.length

  // ─── Render ───────────────────────────────────────────────────────────────

  if (savedResults) {
    return (
      <div className="min-h-screen bg-bg-base p-4 flex flex-col items-center justify-center gap-6">
        <CheckCircle2 className="w-16 h-16 text-success" />
        <div className="text-center">
          <h1 className="text-xl font-semibold text-text-primary">Inventário salvo!</h1>
          <p className="text-text-secondary mt-1">
            {savedResults.applied} ajuste{savedResults.applied !== 1 ? 's' : ''} aplicado{savedResults.applied !== 1 ? 's' : ''}
            {savedResults.errors > 0 && `, ${savedResults.errors} com erro`}.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/estoque">
            <Button variant="outline">Ver Estoque</Button>
          </Link>
          <Button onClick={() => setSavedResults(null)}>
            Novo Inventário
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg-base pb-32">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 bg-bg-base border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href="/estoque" className="text-text-secondary hover:text-text-primary">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-semibold text-text-primary leading-tight">
              Inventário Físico
            </h1>
            <p className="text-xs text-text-secondary">
              {touchedCount > 0
                ? `${touchedCount} item${touchedCount !== 1 ? 'ns' : ''} contado${touchedCount !== 1 ? 's' : ''} · ${deltaCount} ajuste${deltaCount !== 1 ? 's' : ''}`
                : 'Toque em um produto para registrar a contagem'}
            </p>
          </div>
          {touchedCount > 0 && (
            <button
              type="button"
              onClick={() => { setCounts({}); setExpanded(new Set()) }}
              className="p-2 text-text-secondary hover:text-text-primary"
              title="Limpar todas as contagens"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Busca */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
            <Input
              placeholder="Buscar por nome, SKU, cor ou tamanho…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      {/* ── Lista de produtos ── */}
      <div className="px-4 pt-3 space-y-2">
        {isLoading && (
          <div className="text-center py-16 text-text-secondary text-sm">
            Carregando estoque…
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-16 text-text-secondary text-sm">
            Nenhum produto encontrado.
          </div>
        )}

        {filtered.map((item) => {
          const pvid    = item.product_variation_id
          const counted = getCountedQty(pvid)
          const delta   = getDelta(item)
          const isOpen  = expanded.has(pvid)
          const isTouched = counts[pvid] !== undefined

          const deltaColor =
            delta === null ? '' :
            delta > 0 ? 'text-success' :
            delta < 0 ? 'text-error'   : 'text-text-secondary'

          return (
            <Card
              key={pvid}
              className={`border transition-colors ${
                isTouched && delta !== 0
                  ? 'border-brand/40 bg-brand/5'
                  : isTouched
                  ? 'border-success/30 bg-success/5'
                  : 'border-border'
              }`}
            >
              {/* Linha principal */}
              <button
                type="button"
                className="w-full text-left"
                onClick={() => toggleExpanded(pvid)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Package className="w-5 h-5 text-text-tertiary mt-0.5 shrink-0" />

                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-text-primary text-sm truncate">
                        {item.product_name}
                      </p>
                      <p className="text-xs text-text-secondary mt-0.5">
                        {[item.sku_variation, item.tamanho, item.cor]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-text-primary">
                        {item.current_qty} <span className="text-xs font-normal text-text-secondary">atual</span>
                      </div>
                      {counted !== null && (
                        <div className={`text-xs font-medium ${deltaColor}`}>
                          {delta === 0 ? '= ok' :
                           delta! > 0 ? `+${delta} ↑` : `${delta} ↓`}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 text-text-tertiary">
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CardContent>
              </button>

              {/* Painel de contagem */}
              {isOpen && (
                <div className="px-4 pb-4 border-t border-border/50 pt-3">
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="bg-bg-elevated rounded-lg p-3 text-center">
                      <p className="text-xs text-text-secondary">Estoque atual</p>
                      <p className="text-2xl font-bold text-text-primary mt-1">
                        {item.current_qty}
                      </p>
                    </div>

                    <div className="bg-bg-elevated rounded-lg p-3 text-center">
                      <p className="text-xs text-text-secondary">Contagem física</p>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={counts[pvid] ?? ''}
                        onChange={(e) =>
                          setCounts((prev) => ({ ...prev, [pvid]: e.target.value }))
                        }
                        placeholder="0"
                        className="w-full text-2xl font-bold text-center bg-transparent outline-none text-text-primary mt-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </div>
                  </div>

                  {/* Delta calculado */}
                  {counted !== null && (
                    <div className={`flex items-center gap-2 rounded-lg p-3 mb-3 ${
                      delta === 0  ? 'bg-success/10 text-success' :
                      delta! > 0   ? 'bg-success/10 text-success' :
                                     'bg-error/10 text-error'
                    }`}>
                      {delta === 0  ? <Minus className="w-4 h-4 shrink-0" />   :
                       delta! > 0   ? <TrendingUp className="w-4 h-4 shrink-0" /> :
                                      <TrendingDown className="w-4 h-4 shrink-0" />}
                      <span className="text-sm font-medium">
                        {delta === 0
                          ? 'Sem diferença — estoque confirma'
                          : `Diferença: ${delta! > 0 ? '+' : ''}${delta} unidade${Math.abs(delta!) !== 1 ? 's' : ''}`}
                      </span>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="flex-1 text-text-secondary"
                      onClick={() => resetItem(pvid)}
                    >
                      Limpar
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => toggleExpanded(pvid)}
                    >
                      Confirmar
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {/* ── Barra de ação fixa no rodapé ── */}
      {touchedCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-20 bg-bg-base border-t border-border p-4 safe-area-bottom">
          <div className="max-w-2xl mx-auto space-y-2">
            {/* Mini-resumo */}
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <span className="text-text-secondary">Contados</span>
                <p className="font-semibold text-text-primary">{touchedCount}</p>
              </div>
              <div>
                <span className="text-success">Positivos</span>
                <p className="font-semibold text-success">{summary.positive.length}</p>
              </div>
              <div>
                <span className="text-error">Negativos</span>
                <p className="font-semibold text-error">{summary.negative.length}</p>
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowSummary(true)}
              >
                <ClipboardList className="w-4 h-4 mr-2" />
                Ver resumo
              </Button>
              <Button
                className="flex-1"
                disabled={deltaCount === 0 || saving}
                onClick={handleSave}
              >
                <Save className="w-4 h-4 mr-2" />
                {saving ? 'Salvando…' : `Salvar ${deltaCount} ajuste${deltaCount !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de resumo ── */}
      {showSummary && (
        <div
          className="fixed inset-0 z-30 bg-black/60 flex items-end"
          onClick={() => setShowSummary(false)}
        >
          <div
            className="bg-bg-elevated rounded-t-2xl w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-bg-elevated border-b border-border px-5 py-4 flex items-center justify-between">
              <h2 className="font-semibold text-text-primary">Resumo do Inventário</h2>
              <button
                type="button"
                onClick={() => setShowSummary(false)}
                className="text-text-secondary text-sm"
              >
                Fechar
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Totais */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Itens contados',  value: summary.total_counted,  color: 'text-text-primary' },
                  { label: 'Com ajuste',       value: summary.total_adjusted, color: 'text-brand' },
                  { label: 'Ajustes +',        value: summary.positive.length, color: 'text-success' },
                  { label: 'Ajustes −',        value: summary.negative.length, color: 'text-error' },
                  { label: 'Sem diferença',    value: summary.unchanged,       color: 'text-text-secondary' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-bg-base rounded-xl p-3">
                    <p className="text-xs text-text-secondary">{label}</p>
                    <p className={`text-xl font-bold ${color}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Maiores diferenças positivas */}
              {summary.positive.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-success mb-2 flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4" /> Ajustes positivos (sobra)
                  </h3>
                  <div className="space-y-2">
                    {summary.positive.slice(0, 10).map((i) => (
                      <div key={i.product_variation_id}
                           className="flex justify-between items-center text-sm py-2 border-b border-border/50 last:border-0">
                        <div>
                          <p className="text-text-primary font-medium">{i.product_name}</p>
                          <p className="text-xs text-text-secondary">
                            {[i.tamanho, i.cor].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-success font-semibold">+{i.delta}</p>
                          <p className="text-xs text-text-secondary">{i.current_qty} → {i.counted}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Maiores diferenças negativas */}
              {summary.negative.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-error mb-2 flex items-center gap-1.5">
                    <TrendingDown className="w-4 h-4" /> Ajustes negativos (falta)
                  </h3>
                  <div className="space-y-2">
                    {summary.negative.slice(0, 10).map((i) => (
                      <div key={i.product_variation_id}
                           className="flex justify-between items-center text-sm py-2 border-b border-border/50 last:border-0">
                        <div>
                          <p className="text-text-primary font-medium">{i.product_name}</p>
                          <p className="text-xs text-text-secondary">
                            {[i.tamanho, i.cor].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-error font-semibold">{i.delta}</p>
                          <p className="text-xs text-text-secondary">{i.current_qty} → {i.counted}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Botão de salvar dentro do modal */}
              <Button
                className="w-full"
                size="lg"
                disabled={deltaCount === 0 || saving}
                onClick={() => { setShowSummary(false); handleSave() }}
              >
                <Save className="w-4 h-4 mr-2" />
                {saving ? 'Salvando…' : `Confirmar e salvar ${deltaCount} ajuste${deltaCount !== 1 ? 's' : ''}`}
              </Button>

              {deltaCount === 0 && (
                <p className="text-center text-sm text-text-secondary">
                  Nenhum ajuste para salvar.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
