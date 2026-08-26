import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { resolveDateRange } from '@/lib/utils/dateRange'
import { DateRangePicker } from '@/components/modules/dashboards/date-range-picker'
import { ModalityComparisonTable } from '@/components/modules/dashboards/modality-comparison-table'
import { ModalityTrendChart } from '@/components/modules/dashboards/modality-trend-chart'
import { getModalityComparison, getDailyModalityRevenue } from '@/services/analytics/modalityAnalytics'
import { getSellerReport } from '@/services/sellerDashboard'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{ range?: string; from?: string; to?: string; channel?: string }>

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'pos', label: 'PDV' },
  { value: 'manual', label: 'Manual' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'nuvemshop', label: 'Nuvemshop' },
  { value: 'wholesale_site', label: 'Site Atacado' },
]

export default async function VarejoAtacadoReportPage({ searchParams }: { searchParams: SearchParams }) {
  const profile = await requirePageRole('gerente')
  if (!profile.company_id) return <p className="text-sm text-text-muted p-6">Sem empresa vinculada.</p>

  const { range, from, to, channel } = await searchParams
  const { dateFrom, dateTo, activeRange, rangeLabel } = resolveDateRange(range, from, to)
  // sale_type e sales_channel continuam conceitos separados (seção "CANAL"
  // do pedido) — este filtro cruza os dois SEM misturá-los: só restringe
  // quais vendas entram na comparação por company_id+período+canal; quem
  // decide varejo/atacado continua sendo sale_type, sempre as duas colunas
  // da tabela (nunca "escolha um canal e perca a modalidade").
  const activeChannel = CHANNEL_OPTIONS.some((c) => c.value === channel) ? channel : undefined

  const [comparison, dailyRevenue, sellerReport] = await Promise.all([
    getModalityComparison(profile.company_id, dateFrom, dateTo, { salesChannel: activeChannel }),
    getDailyModalityRevenue(profile.company_id, dateFrom, dateTo),
    getSellerReport(profile.company_id, dateFrom, dateTo),
  ])

  const sellersWithSales = sellerReport.rows.filter((r) => r.orders > 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href="/relatorios">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Varejo × Atacado</h1>
            <p className="text-sm text-text-muted">{rangeLabel}</p>
          </div>
        </div>
        <DateRangePicker
          activeRange={activeRange}
          dateFrom={activeRange === 'custom' ? dateFrom : undefined}
          dateTo={activeRange === 'custom' ? dateTo : undefined}
        />
      </div>

      {/* ── Filtro de canal (cruzamento sale_type × sales_channel) ──────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-muted">Canal:</span>
        <Link
          href={`/relatorios/varejo-atacado?range=${activeRange}${activeRange === 'custom' ? `&from=${dateFrom}&to=${dateTo}` : ''}`}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${!activeChannel ? 'bg-brand text-white' : 'bg-bg-subtle text-text-secondary border border-border'}`}
        >
          Todos
        </Link>
        {CHANNEL_OPTIONS.map((c) => (
          <Link
            key={c.value}
            href={`/relatorios/varejo-atacado?range=${activeRange}${activeRange === 'custom' ? `&from=${dateFrom}&to=${dateTo}` : ''}&channel=${c.value}`}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${activeChannel === c.value ? 'bg-brand text-white' : 'bg-bg-subtle text-text-secondary border border-border'}`}
          >
            {c.label}
          </Link>
        ))}
      </div>

      {/* ── Visão principal: comparação ──────────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text-primary">Comparação — {rangeLabel}{activeChannel ? ` · ${CHANNEL_OPTIONS.find(c => c.value === activeChannel)?.label}` : ''}</h2>
        </CardHeader>
        <ModalityComparisonTable comparison={comparison} />
      </Card>

      {/* ── Evolução no tempo ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text-primary">Evolução de Faturamento</h2>
          <p className="text-xs text-text-muted">Varejo, Atacado e Total — {rangeLabel}</p>
        </CardHeader>
        <CardContent>
          <ModalityTrendChart data={dailyRevenue} />
        </CardContent>
      </Card>

      {/* ── Por vendedor ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text-primary">Por Vendedor</h2>
        </CardHeader>
        {sellersWithSales.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">Nenhuma venda no período.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Vendedor</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500 uppercase tracking-wider">Varejo</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-purple-500 uppercase tracking-wider">Atacado</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Total</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Vendas</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Ticket Médio</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">CMV</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Lucro Bruto</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Margem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sellersWithSales.map((row) => (
                  <tr key={row.sellerId ?? 'none'} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 font-medium text-text-primary">{row.sellerName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.retail.revenue > 0 ? formatCurrency(row.retail.revenue) : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.wholesale.revenue > 0 ? formatCurrency(row.wholesale.revenue) : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{formatCurrency(row.revenue)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.orders}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(row.avgTicket)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(row.revenue - row.grossProfit)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-success">{formatCurrency(row.grossProfit)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.grossMarginPct != null ? `${row.grossMarginPct.toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
