import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, ShoppingCart, Info, AlertTriangle, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { ComprasTable, type PurchaseSuggestion } from './_components/compras-table'

export const dynamic = 'force-dynamic'

async function getPurchaseSuggestions(): Promise<PurchaseSuggestion[]> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('vw_purchase_suggestions')
    .select('*') as unknown as { data: PurchaseSuggestion[] | null; error: any }

  if (error) console.error('vw_purchase_suggestions error:', error.message)
  return data ?? []
}

export default async function ComprasPage() {
  await requirePageRole('gerente')

  const suggestions = await getPurchaseSuggestions()

  const criticas     = suggestions.filter(s => s.urgency === 'critica').length
  const alta         = suggestions.filter(s => s.urgency === 'alta').length
  const parados      = suggestions.filter(s => s.is_dead_stock).length
  const custoUrgente = suggestions
    .filter(s => s.urgency === 'critica' || s.urgency === 'alta')
    .reduce((sum, s) => sum + parseFloat(s.estimated_restock_cost ?? '0'), 0)
  // Valor imobilizado em dead stock: current_qty × unit_cost_estimate (campos já na view)
  const valorParado  = suggestions
    .filter(s => s.is_dead_stock)
    .reduce((sum, s) => sum + s.current_qty * parseFloat(s.unit_cost_estimate ?? '0'), 0)

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
              <p className="text-sm text-text-muted">Sugestões de reposição por variação com base em estoque, vendas e fornecedor</p>
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

      {/* Alerta de rupturas críticas */}
      {criticas > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-error/8 border border-error/30 text-sm text-error">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Existem <strong>{criticas} variações</strong> com ruptura crítica.
            Priorize a reposição antes de comprar produtos novos.
          </span>
        </div>
      )}

      {/* Aviso lead time */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-info/8 border border-info/20 text-xs text-info">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          O lead time exibido é <strong>estimado</strong> com base no intervalo histórico entre lotes de compra.
          Para variações com menos de 2 lotes, assume-se 30 dias. Ajuste conforme acordos com seus fornecedores.
        </span>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`card p-4 ${criticas > 0 ? 'border-error/40' : ''}`}>
          <p className="text-xs text-text-muted mb-1">Rupturas críticas</p>
          <p className={`text-2xl font-bold ${criticas > 0 ? 'text-error' : 'text-text-primary'}`}>
            {criticas}
          </p>
          <p className="text-xs text-text-muted mt-0.5">estoque zero, produto vende</p>
        </div>

        <div className={`card p-4 ${alta > 0 ? 'border-warning/40' : ''}`}>
          <p className="text-xs text-text-muted mb-1">Urgência alta</p>
          <p className={`text-2xl font-bold ${alta > 0 ? 'text-warning' : 'text-text-primary'}`}>
            {alta}
          </p>
          <p className="text-xs text-text-muted mt-0.5">cobertura &lt; lead time</p>
        </div>

        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Custo estimado</p>
          <p className="text-2xl font-bold text-text-primary">
            {formatCurrency(custoUrgente)}
          </p>
          <p className="text-xs text-text-muted mt-0.5">para repor críticos + altos</p>
        </div>

        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Produtos parados</p>
          <p className="text-2xl font-bold text-text-primary">{parados}</p>
          <p className="text-xs text-text-muted mt-0.5">
            sem venda em 90 dias
            {valorParado > 0 && (
              <> · <span className="text-warning">{formatCurrency(valorParado)} imob.</span></>
            )}
          </p>
        </div>
      </div>

      {/* Tabela */}
      <ComprasTable suggestions={suggestions} />
    </div>
  )
}
