'use client'

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'

const CORES_PALETTE = [
  '#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6',
  '#8b5cf6','#ec4899','#14b8a6','#f97316','#84cc16',
  '#06b6d4','#a855f7','#64748b','#e11d48','#0ea5e9',
]

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const { name, value, pct } = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-bg-card px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-text-primary">{name}</p>
      <p className="text-text-muted">{value} unid. · {pct.toFixed(1)}%</p>
    </div>
  )
}

function CustomLegend({ payload }: any) {
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {payload?.map((entry: any) => (
        <li key={entry.value} className="flex items-center gap-1.5 text-xs text-text-muted">
          <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          {entry.value}
        </li>
      ))}
    </ul>
  )
}

interface PieData { name: string; value: number; pct: number }

interface Props {
  byColor: PieData[]
  bySize: PieData[]
  coverageItems: { name: string; dias: number; qty: number }[]
}

export function DashboardCharts({ byColor, bySize, coverageItems }: Props) {
  const MAX_COVERAGE = Math.max(...coverageItems.map(i => i.dias), 90)

  return (
    <div className="grid gap-5 xl:grid-cols-3">

      {/* — Pizza: vendas por COR — */}
      <div className="card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">Vendas por Cor</p>
          <p className="text-xs text-text-muted">últimos 90 dias · por unidades</p>
        </div>
        {byColor.length === 0 ? (
          <p className="py-10 text-center text-xs text-text-muted">Sem dados de cor nas variações</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={byColor}
                cx="50%"
                cy="45%"
                innerRadius={48}
                outerRadius={78}
                paddingAngle={2}
                dataKey="value"
              >
                {byColor.map((_, i) => (
                  <Cell key={i} fill={CORES_PALETTE[i % CORES_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend content={<CustomLegend />} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* — Pizza: vendas por TAMANHO — */}
      <div className="card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">Vendas por Tamanho</p>
          <p className="text-xs text-text-muted">últimos 90 dias · por unidades</p>
        </div>
        {bySize.length === 0 ? (
          <p className="py-10 text-center text-xs text-text-muted">Sem dados de tamanho nas variações</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={bySize}
                cx="50%"
                cy="45%"
                innerRadius={48}
                outerRadius={78}
                paddingAngle={2}
                dataKey="value"
              >
                {bySize.map((_, i) => (
                  <Cell key={i} fill={CORES_PALETTE[i % CORES_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend content={<CustomLegend />} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* — Cobertura de estoque por produto — */}
      <div className="card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">Cobertura por Produto</p>
          <p className="text-xs text-text-muted">top 8 — dias de estoque restante</p>
        </div>
        {coverageItems.length === 0 ? (
          <p className="py-10 text-center text-xs text-text-muted">Sem dados de vendas recentes</p>
        ) : (
          <div className="space-y-2.5">
            {coverageItems.map((item) => {
              const pct = Math.min((item.dias / MAX_COVERAGE) * 100, 100)
              const cor = item.dias < 15 ? 'bg-error' : item.dias < 30 ? 'bg-warning' : 'bg-success'
              const textCor = item.dias < 15 ? 'text-error' : item.dias < 30 ? 'text-warning' : 'text-success'
              return (
                <div key={item.name}>
                  <div className="flex justify-between items-baseline mb-1 gap-2">
                    <span className="text-xs text-text-secondary truncate flex-1">{item.name}</span>
                    <span className={`text-xs font-bold tabular-nums shrink-0 ${textCor}`}>
                      {item.dias > 999 ? '>999d' : `${item.dias}d`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-bg-overlay rounded-full">
                    <div
                      className={`h-full rounded-full transition-all ${cor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
            <p className="text-[10px] text-text-muted pt-1">
              🟢 &gt;30d · 🟡 15–30d · 🔴 &lt;15d
            </p>
          </div>
        )}
      </div>

    </div>
  )
}
