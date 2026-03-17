import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { RfmBadge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import type { RfmSegment } from '@/types/database.types'

export const dynamic = 'force-dynamic'

async function getRfmData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_customer_rfm')
    .select('customer_id, days_since_last_purchase, purchase_count, total_spent, r_score, f_score, m_score, rfm_total, segment')
    .order('rfm_total', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  const rfmData = data ?? []

  if (rfmData.length === 0) return { items: [], bySegment: {} as Record<string, number> }

  const customerIds = rfmData.map(r => r.customer_id)
  const { data: customers } = await supabase
    .from('customers')
    .select('id, name, phone, city')
    .in('id', customerIds) as unknown as { data: any[] | null }

  const custMap = Object.fromEntries((customers ?? []).map(c => [c.id, c]))
  const items = rfmData.map(r => ({ ...r, customer: custMap[r.customer_id] ?? {} }))

  const bySegment = items.reduce((acc: Record<string, number>, r) => {
    acc[r.segment] = (acc[r.segment] ?? 0) + 1
    return acc
  }, {})

  return { items, bySegment }
}

const SEGMENT_INFO: Record<string, { label: string; desc: string }> = {
  champions:       { label: 'Champions',    desc: 'Compram muito, frequente e recente' },
  loyal:           { label: 'Leais',         desc: 'Compram com frequência e alto valor' },
  potential_loyal: { label: 'Potencial',     desc: 'Recentes, podem se tornar leais' },
  new_customers:   { label: 'Novos',         desc: 'Compraram recentemente, pouca freq.' },
  promising:       { label: 'Promissores',   desc: 'Recentes mas baixa frequência' },
  at_risk:         { label: 'Em Risco',      desc: 'Eram bons clientes, estão sumindo' },
  cant_lose:       { label: 'Não Perca',     desc: 'Muito valiosos mas inativos' },
  hibernating:     { label: 'Hibernando',    desc: 'Pouco valor e sem comprar há muito' },
  lost:            { label: 'Perdidos',      desc: 'Não compraram mais' },
}

export default async function MapaRfmPage() {
  const { items, bySegment } = await getRfmData()

  const totalSpent = items.reduce((s, r) => s + (r.total_spent ?? 0), 0)
  const champions = bySegment['champions'] ?? 0
  const atRisk = (bySegment['at_risk'] ?? 0) + (bySegment['cant_lose'] ?? 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Mapa RFM</h2>
          <p className="text-sm text-text-muted">Segmentação por Recência, Frequência e Valor</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Clientes Analisados', value: items.length },
          { label: 'Receita Total', value: formatCurrency(totalSpent) },
          { label: 'Champions', value: champions, sub: 'clientes top', className: 'text-amber-400' },
          { label: 'Em Risco', value: atRisk, sub: 'precisam de atenção', className: atRisk > 0 ? 'text-warning' : 'text-text-primary' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.className ?? 'text-text-primary'}`}>{kpi.value}</p>
            {kpi.sub && <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* Segmentos */}
      {Object.keys(bySegment).length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Distribuição por Segmento</h3>
          </CardHeader>
          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(Object.entries(bySegment) as [string, number][]).sort(([, a], [, b]) => b - a).map(([seg, count]) => {
              const info = SEGMENT_INFO[seg] ?? { label: seg, desc: '' }
              return (
                <div key={seg} className="flex items-start gap-3 p-3 rounded-xl bg-bg-overlay border border-border">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <RfmBadge segment={seg as RfmSegment} />
                      <span className="text-sm font-bold text-text-primary">{count}</span>
                    </div>
                    <p className="text-xs text-text-muted truncate">{info.desc}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Tabela */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Clientes com Score RFM</h3>
        </CardHeader>
        {items.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">
            Sem dados para análise RFM. Registre vendas para ver a segmentação de clientes.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead align="right">Total Gasto</TableHead>
                <TableHead align="right">Pedidos</TableHead>
                <TableHead align="right">Dias s/ Compra</TableHead>
                <TableHead align="center">R</TableHead>
                <TableHead align="center">F</TableHead>
                <TableHead align="center">M</TableHead>
                <TableHead align="center">Segmento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.customer_id}>
                  <TableCell>
                    <Link href={`/clientes/${r.customer_id}`} className="font-medium hover:text-accent">
                      {r.customer?.name ?? '—'}
                    </Link>
                  </TableCell>
                  <TableCell muted>{r.customer?.city ?? '—'}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(r.total_spent ?? 0)}</TableCell>
                  <TableCell align="right">{r.purchase_count ?? 0}</TableCell>
                  <TableCell align="right" muted>{r.days_since_last_purchase ?? '—'}d</TableCell>
                  <TableCell align="center">
                    <span className={`text-xs font-bold ${(r.r_score ?? 0) >= 4 ? 'text-success' : (r.r_score ?? 0) >= 3 ? 'text-warning' : 'text-error'}`}>
                      {r.r_score ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell align="center">
                    <span className={`text-xs font-bold ${(r.f_score ?? 0) >= 4 ? 'text-success' : (r.f_score ?? 0) >= 3 ? 'text-warning' : 'text-error'}`}>
                      {r.f_score ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell align="center">
                    <span className={`text-xs font-bold ${(r.m_score ?? 0) >= 4 ? 'text-success' : (r.m_score ?? 0) >= 3 ? 'text-warning' : 'text-error'}`}>
                      {r.m_score ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell align="center">
                    <RfmBadge segment={r.segment as RfmSegment} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
