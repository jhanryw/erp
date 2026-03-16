'use client'

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

interface Props {
  data: { sale_date: string; gross_revenue: number; total_orders: number }[]
}

export function DailySalesChart({ data }: Props) {
  const formatted = data.map((d) => ({
    date: formatDate(d.sale_date, 'dd/MM'),
    revenue: d.gross_revenue,
    orders: d.total_orders,
  }))

  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={formatted} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#A71818" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#A71818" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            width={52}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1A1A',
              border: '1px solid #27272A',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelStyle={{ color: '#A1A1AA' }}
            itemStyle={{ color: '#F4A8A9' }}
            formatter={(value: number) => [formatCurrency(value), 'Faturamento']}
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="#A71818"
            strokeWidth={2}
            fill="url(#revenueGrad)"
            dot={false}
            activeDot={{ r: 4, fill: '#A71818' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
