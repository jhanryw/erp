import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft, ShoppingCart, Info, AlertTriangle, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { ComprasTable } from './_components/compras-table'
import { getEnrichedPurchaseSuggestions, summarizeByCurve } from '@/services/purchaseSuggestions'
import { CURVE_LABELS } from '@/lib/constants/purchasePolicy'

export const dynamic = 'force-dynamic'

export default async function ComprasPage() {
  await requirePageRole('gerente')

  const suggestions = await getEnrichedPurchaseSuggestions()
  const summary = summarizeByCurve(suggestions)

  // Ruptura ativa = estoque zero com alguma venda recente (qualquer curva) — para o alerta no topo.
  const rupturasAtivas = suggestions.filter((s) => s.availableStock === 0 && s.vmdProjetada > 0).length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/inteligencia">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div className="flex items-center gap-3">
            <ShoppingCart className="w-5 h-5 text-warning" />
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Compras Inteligentes</h2>
              <p className="text-sm text-text-muted">
                Cobertura-alvo por Curva ABC — quanto comprar hoje para levar cada SKU até a cobertura da sua curva
              </p>
            </div>
          </div>
        </div>
        <Link
          href="/inteligencia/compras/pedido"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:border-brand/50 transition-colors shrink-0"
        >
          <ClipboardList className="w-4 h-4" />
          Gerar pedido sugerido
        </Link>
      </div>

      {/* Alerta de rupturas ativas */}
      {rupturasAtivas > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-error/8 border border-error/30 text-sm text-error">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Existem <strong>{rupturasAtivas} variações</strong> com estoque zerado e venda recente.
            Priorize a reposição antes de comprar produtos novos.
          </span>
        </div>
      )}

      {/* Aviso de política e limitações conhecidas */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-info/8 border border-info/20 text-xs text-info">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Cobertura-alvo: Curva A = 90 dias, Curva B = 30 dias, produtos novos/sem histórico = 30 dias,
          Curva C = reposição mínima ao zerar. Não desconta mercadoria em trânsito/comprada e ainda não recebida —
          esse dado não existe hoje no sistema. O lead time e a grade mínima (MOQ) da Curva C ainda são estimados.
        </span>
      </div>

      {/* Cards de resumo por curva */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4 border-error/30">
          <p className="text-xs text-text-muted mb-1">Curva A — 90 dias</p>
          <p className="text-2xl font-bold text-text-primary">{formatCurrency(summary.byCurve.A.estimatedCost)}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {summary.byCurve.A.skuWithSuggestionCount} SKUs com compra sugerida · {summary.byCurve.A.ruptureCount} em ruptura
          </p>
        </div>

        <div className="card p-4 border-warning/30">
          <p className="text-xs text-text-muted mb-1">Curva B — 30 dias</p>
          <p className="text-2xl font-bold text-text-primary">{formatCurrency(summary.byCurve.B.estimatedCost)}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {summary.byCurve.B.skuWithSuggestionCount} SKUs com compra sugerida
          </p>
        </div>

        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Curva C — mínimo</p>
          <p className="text-2xl font-bold text-text-primary">{formatCurrency(summary.byCurve.C.estimatedCost)}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {summary.byCurve.C.skuCount - summary.byCurve.C.skuWithSuggestionCount} SKUs sem reposição
          </p>
        </div>

        <div className="card p-4 border-brand/30">
          <p className="text-xs text-text-muted mb-1">Compra total recomendada</p>
          <p className="text-2xl font-bold text-brand">{formatCurrency(summary.totalEstimatedCost)}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {summary.totalSuggestedUnits} unidades · inclui {CURVE_LABELS.NEW} ({formatCurrency(summary.byCurve.NEW.estimatedCost)})
          </p>
        </div>
      </div>

      {/* Estoque atual x compra recomendada — apenas soma, não é projeção de vendas futuras */}
      <div className="card p-4">
        <p className="text-xs text-text-muted mb-2">
          Estoque atual a custo + compra recomendada (não é projeção após vendas futuras — apenas soma dos dois valores)
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="text-[11px] text-text-muted">Estoque atual a custo</p>
            <p className="text-lg font-semibold text-text-primary">{formatCurrency(summary.currentStockValueAtCost)}</p>
          </div>
          <span className="text-text-muted">+</span>
          <div>
            <p className="text-[11px] text-text-muted">Compra recomendada</p>
            <p className="text-lg font-semibold text-text-primary">{formatCurrency(summary.totalEstimatedCost)}</p>
          </div>
          <span className="text-text-muted">=</span>
          <div>
            <p className="text-[11px] text-text-muted">Estoque teórico após compra</p>
            <p className="text-lg font-semibold text-brand">{formatCurrency(summary.theoreticalStockValueAfterPurchase)}</p>
          </div>
        </div>
      </div>

      {/* Tabela */}
      <ComprasTable suggestions={suggestions} />
    </div>
  )
}
