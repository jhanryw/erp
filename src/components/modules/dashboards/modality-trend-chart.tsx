'use client'

/**
 * Evolução de faturamento Varejo × Atacado × Total — Analytics
 * Varejo/Atacado. Reaproveita recharts (já usado em `daily-sales-chart.tsx`/
 * `sales-by-origin-chart.tsx` — nenhuma biblioteca nova instalada) e o
 * formato wide já vindo de `getDailyModalityRevenue`. Toggle Diário/Mensal
 * é só uma reagregação em memória do MESMO array recebido — nenhuma
 * segunda consulta ao backend.
 */

import { useMemo, useState } from 'react'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { formatCurrency } from '@/lib/utils/currency'
import type { DailyModalityRevenuePoint } from '@/services/analytics/modalityAnalytics'

interface Props {
  data: DailyModalityRevenuePoint[]
}

const RETAIL_COLOR = '#3b82f6'
const WHOLESALE_COLOR = '#a855f7'
const TOTAL_COLOR = '#F2B33D'

function toMonthly(daily: DailyModalityRevenuePoint[]) {
  const byMonth: Record<string, { retailRevenue: number; wholesaleRevenue: number; totalRevenue: number }> = {}
  for (const d of daily) {
    const month = d.sale_date.slice(0, 7) // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { retailRevenue: 0, wholesaleRevenue: 0, totalRevenue: 0 }
    byMonth[month].retailRevenue += d.retailRevenue
    byMonth[month].wholesaleRevenue += d.wholesaleRevenue
    byMonth[month].totalRevenue += d.totalRevenue
  }
  return Object.entries(byMonth)
    .map(([month, v]) => ({ sale_date: month, ...v }))
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date))
}

export function ModalityTrendChart({ data }: Props) {
  const [granularity, setGranularity] = useState<'daily' | 'monthly'>('daily')

  const chartData = useMemo(() => (granularity === 'monthly' ? toMonthly(data) : data), [data, granularity])

  if (data.length === 0) {
    return <p className="text-sm text-text-muted py-8 text-center">Nenhuma venda no período.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        {(['daily', 'monthly'] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGranularity(g)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              granularity === g ? 'bg-brand text-white' : 'bg-bg-subtle text-text-secondary border border-border'
            }`}
          >
            {g === 'daily' ? 'Diário' : 'Mensal'}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
          <XAxis dataKey="sale_date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(v: number) => formatCurrency(v)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="retailRevenue" name="Varejo" stackId="modality" fill={RETAIL_COLOR} radius={[0, 0, 0, 0]} />
          <Bar dataKey="wholesaleRevenue" name="Atacado" stackId="modality" fill={WHOLESALE_COLOR} radius={[4, 4, 0, 0]} />
          <Line dataKey="totalRevenue" name="Total" stroke={TOTAL_COLOR} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
