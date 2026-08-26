import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { getSellerReport } from '@/services/sellerDashboard'
import { formatCurrency } from '@/lib/utils/currency'
import { brazilDate, brazilSubDays } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  from?:      string
  to?:        string
}>

function fmt(n: number) { return formatCurrency(n) }
function pct(n: number) { return `${n.toFixed(1)}%` }

export default async function VendedoresReportPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageRole('gerente')

  const { from, to } = await searchParams
  const today    = brazilDate()
  const dateFrom = from && from <= today ? from : brazilSubDays(29)
  const dateTo   = to   && to   <= today ? to   : today

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null

  if (!profile?.company_id) {
    return <p className="text-sm text-text-muted p-6">Sem empresa vinculada.</p>
  }

  const { rows, totalRevenue, totalOrders } = await getSellerReport(
    profile.company_id, dateFrom, dateTo,
  )

  const [fy, fm, fd] = dateFrom.split('-')
  const [ty, tm, td] = dateTo.split('-')
  const rangeLabel = dateFrom === dateTo
    ? `${fd}/${fm}/${fy}`
    : `${fd}/${fm}/${fy} – ${td}/${tm}/${ty}`

  return (
    <div className="space-y-6">
      {/* ── Cabeçalho ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Relatório por Vendedor</h1>
          <p className="text-sm text-text-muted">{rangeLabel}</p>
        </div>

        {/* Filtro de período */}
        <form method="GET" className="flex items-center gap-2 flex-wrap">
          <label className="text-sm text-text-muted">De</label>
          <input
            type="date"
            name="from"
            defaultValue={dateFrom}
            max={today}
            className="text-sm rounded-lg border border-border bg-bg-surface px-2 py-1.5 text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <label className="text-sm text-text-muted">até</label>
          <input
            type="date"
            name="to"
            defaultValue={dateTo}
            max={today}
            className="text-sm rounded-lg border border-border bg-bg-surface px-2 py-1.5 text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <button
            type="submit"
            className="text-sm rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand/90 transition-colors"
          >
            Filtrar
          </button>
        </form>
      </div>

      {/* ── Totais da empresa ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Faturamento Total</p>
          <p className="text-xl font-bold text-text-primary">{fmt(totalRevenue)}</p>
          <p className="text-xs text-text-muted mt-1">{rangeLabel}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total de Pedidos</p>
          <p className="text-xl font-bold text-text-primary">{totalOrders}</p>
          <p className="text-xs text-text-muted mt-1">Vendas ativas no período</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Ticket Médio Geral</p>
          <p className="text-xl font-bold text-text-primary">
            {fmt(totalOrders > 0 ? totalRevenue / totalOrders : 0)}
          </p>
          <p className="text-xs text-text-muted mt-1">{rangeLabel}</p>
        </div>
      </div>

      {/* ── Tabela por vendedor ────────────────────────────────────── */}
      {rows.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-muted">Nenhuma venda no período.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Vendedor</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Faturamento</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500/80 uppercase tracking-wider">Varejo</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-purple-500/80 uppercase tracking-wider">Atacado</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Pedidos</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">% Total</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Ticket Médio</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Lucro Bruto</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Margem</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Descontos</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Desconto %</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Canc.</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Dev.</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Trocas</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Clientes</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Top Produto</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Pgto.</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Canal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, i) => (
                <tr
                  key={row.sellerId ?? 'none'}
                  className={[
                    'hover:bg-bg-hover transition-colors',
                    row.sellerId === null ? 'opacity-60 italic' : '',
                  ].join(' ')}
                >
                  <td className="px-4 py-3 font-medium text-text-primary whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand">
                        {row.sellerName.charAt(0).toUpperCase()}
                      </div>
                      {row.sellerName}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-text-primary">{fmt(row.revenue)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs text-text-secondary">{row.retail.revenue > 0 ? fmt(row.retail.revenue) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs text-text-secondary">{row.wholesale.revenue > 0 ? fmt(row.wholesale.revenue) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{row.orders}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-bg-overlay overflow-hidden">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, row.pctOfTotal)}%` }} />
                      </div>
                      <span className="tabular-nums text-xs">{pct(row.pctOfTotal)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(row.avgTicket)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-green-600 dark:text-green-400">{fmt(row.grossProfit)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.grossMarginPct !== null ? pct(row.grossMarginPct) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(row.totalDiscounts)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-xs text-text-muted">
                    {row.avgDiscountPct > 0 ? pct(row.avgDiscountPct) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.cancellations > 0
                      ? <span className="text-red-500 font-medium">{row.cancellations}</span>
                      : <span className="text-text-muted">0</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.returns > 0
                      ? <span className="text-orange-500 font-medium">{row.returns}</span>
                      : <span className="text-text-muted">0</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.exchanges > 0
                      ? <span className="text-blue-500 font-medium">{row.exchanges}</span>
                      : <span className="text-text-muted">0</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{row.customers}</td>
                  <td className="px-4 py-3 text-left text-xs text-text-secondary max-w-[140px] truncate">
                    {row.topProduct ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-left text-xs text-text-secondary">{row.topPayment ?? '—'}</td>
                  <td className="px-4 py-3 text-left text-xs text-text-secondary">{row.topOrigin ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-text-muted">
        Lucro bruto e margem calculados sobre itens vendidos (preço − custo × quantidade).
        Vendas sem vendedor responsável aparecem como "Sem vendedor" apenas nesta tela.
      </p>
    </div>
  )
}
