'use client'

import { useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type { RevenueTrendPoint } from '@/services/revenueTrend'

interface Props {
  data: RevenueTrendPoint[]
}

type RangeKey = '7d' | '30d' | '90d' | '6m' | '1a' | 'tudo'

// Dias de calendário a exibir — o corte acontece só na exibição. `data`
// já chega com MM7/MM30 calculadas sobre a série completa (ver
// getRevenueTrend em src/services/revenueTrend.ts), então recortar aqui
// nunca distorce o primeiro ponto da média móvel.
const RANGE_OPTIONS: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '6m', label: '6M', days: 182 },
  { key: '1a', label: '1A', days: 365 },
  { key: 'tudo', label: 'Tudo', days: null },
]

const MM7_COLOR = '#F2B33D'
const MM30_COLOR = '#9CA3AF'

function GrowthBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span className="inline-flex items-center gap-1 text-text-muted">
        <Minus className="h-3 w-3" />—
      </span>
    )
  }
  const neutral = pct === 0
  const positive = pct > 0
  const Icon = neutral ? Minus : positive ? TrendingUp : TrendingDown
  const color = neutral ? 'text-text-muted' : positive ? 'text-success' : 'text-error'
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {positive ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  )
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.payload
  if (!p) return null
  return (
    <div className="rounded-lg border border-border bg-bg-card px-3 py-2.5 text-xs shadow-lg space-y-1 min-w-[210px]">
      <p className="font-semibold text-text-primary">
        {p.dateLabel} · {p.weekday_name}
      </p>
      <div className="flex justify-between gap-3">
        <span className="text-text-muted">Faturamento</span>
        <span className="text-text-primary font-medium">{formatCurrency(p.revenue)}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-text-muted">Pedidos</span>
        <span className="text-text-primary">{p.orders}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-text-muted">Ticket médio</span>
        <span className="text-text-primary">{formatCurrency(p.avg_ticket)}</span>
      </div>
      <div className="border-t border-border my-1" />
      <div className="flex justify-between gap-3">
        <span className="text-text-muted">MM7</span>
        <span style={{ color: MM7_COLOR }}>{formatCurrency(p.mm7)}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-text-muted">MM30</span>
        <span style={{ color: MM30_COLOR }}>{formatCurrency(p.mm30)}</span>
      </div>
      <div className="flex justify-between items-center gap-3">
        <span className="text-text-muted">Variação MM7 (7d)</span>
        <GrowthBadge pct={p.mm7_growth_pct} />
      </div>
      <div className="flex justify-between items-center gap-3">
        <span className="text-text-muted">vs. média de {p.weekday_name}</span>
        <GrowthBadge pct={p.vs_weekday_avg_pct} />
      </div>
    </div>
  )
}

export function DailySalesChart({ data }: Props) {
  const [range, setRange] = useState<RangeKey>('90d')

  const sliced = useMemo(() => {
    const opt = RANGE_OPTIONS.find((r) => r.key === range)
    if (!opt || opt.days === null) return data
    return data.slice(-opt.days)
  }, [data, range])

  const formatted = useMemo(
    () =>
      sliced.map((d) => ({
        ...d,
        dateLabel: formatDate(d.date, 'dd/MM/yy'),
      })),
    [sliced],
  )

  const last = sliced.length > 0 ? sliced[sliced.length - 1] : null
  const avgDaily =
    sliced.length > 0 ? sliced.reduce((sum, d) => sum + d.revenue, 0) / sliced.length : 0

  if (!data || data.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-text-muted">
        Sem histórico de faturamento ainda
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Seletor de período — interno ao gráfico, independente do filtro
          da página. A busca já trouxe o histórico inteiro; aqui só se
          recorta a exibição, nunca se refaz o cálculo das médias. */}
      <div className="flex gap-1.5 flex-wrap">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setRange(opt.key)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              range === opt.key
                ? 'bg-brand text-white'
                : 'bg-bg-subtle text-text-secondary hover:bg-bg-hover border border-border'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* KPIs do período selecionado */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div>
          <p className="text-[11px] text-text-muted">Faturamento (dia mais recente)</p>
          <p className="text-sm font-semibold text-text-primary">
            {formatCurrency(last?.revenue ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">Média diária do período</p>
          <p className="text-sm font-semibold text-text-primary">{formatCurrency(avgDaily)}</p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">MM7 atual</p>
          <p className="text-sm font-semibold" style={{ color: MM7_COLOR }}>
            {formatCurrency(last?.mm7 ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">MM30 atual</p>
          <p className="text-sm font-semibold" style={{ color: MM30_COLOR }}>
            {formatCurrency(last?.mm30 ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">Tendência MM7 (7d)</p>
          <GrowthBadge pct={last?.mm7_growth_pct ?? null} />
        </div>
        <div>
          <p className="text-[11px] text-text-muted">Tendência MM30 (30d)</p>
          <GrowthBadge pct={last?.mm30_growth_pct ?? null} />
        </div>
      </div>

      {/* Gráfico — área de faturamento diário + linhas de MM7/MM30 */}
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={formatted} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#A71818" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#A71818" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272A" vertical={false} />
            <XAxis
              dataKey="dateLabel"
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
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#A71818"
              strokeWidth={2}
              fill="url(#revenueGrad)"
              dot={false}
              activeDot={{ r: 4, fill: '#A71818' }}
              name="Faturamento"
            />
            <Line
              type="monotone"
              dataKey="mm7"
              stroke={MM7_COLOR}
              strokeWidth={1.5}
              dot={false}
              name="MM7"
            />
            <Line
              type="monotone"
              dataKey="mm30"
              stroke={MM30_COLOR}
              strokeWidth={1.5}
              dot={false}
              name="MM30"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
