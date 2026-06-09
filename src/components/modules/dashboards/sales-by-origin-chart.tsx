'use client'

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { DailyOriginPoint, OriginStat } from '@/services/dashboard'
import { ORIGIN_COLORS, ORIGIN_LABELS } from '@/lib/constants/origins'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

interface Props {
  dailyOriginSeries: DailyOriginPoint[]
  originBreakdown: OriginStat[]
}

export function SalesByOriginChart({ dailyOriginSeries, originBreakdown }: Props) {
  // Determina quais origens têm dados (ordem decrescente por revenue)
  const activeOrigins = originBreakdown.map(o => o.origin)

  if (dailyOriginSeries.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center">
        <p className="text-sm text-text-muted">Nenhuma venda com origem no período.</p>
      </div>
    )
  }

  const formatted = dailyOriginSeries.map(d => ({
    date: formatDate(d.sale_date as string, 'dd/MM'),
    ...d,
  }))

  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={formatted} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barSize={12}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272A" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: '#71717A', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: '#71717A', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `R$${(v / 1000).toFixed(0)}k`}
            width={48}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1A1A',
              border: '1px solid #27272A',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelStyle={{ color: '#A1A1AA' }}
            formatter={(value: number, name: string) => [
              formatCurrency(value),
              ORIGIN_LABELS[name] ?? name,
            ]}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          />
          <Legend
            formatter={(value) => (
              <span style={{ color: '#A1A1AA', fontSize: 11 }}>
                {ORIGIN_LABELS[value] ?? value}
              </span>
            )}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ paddingTop: 8 }}
          />
          {activeOrigins.map((origin) => (
            <Bar
              key={origin}
              dataKey={origin}
              stackId="a"
              fill={ORIGIN_COLORS[origin] ?? '#6b7280'}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
