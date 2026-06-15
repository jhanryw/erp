'use client'

import { useState, useTransition } from 'react'
import { simulateTaxes, type SimulationResult, type RegimeFull } from '../actions'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { TrendingUp, AlertTriangle, Trophy } from 'lucide-react'

const UFS = [
  'AC','AL','AM','AP','BA','CE','DF','ES','GO','MA',
  'MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN',
  'RO','RR','RS','SC','SE','SP','TO',
]

const REGIME_LABELS: Record<string, string> = {
  simples_nacional: 'Simples Nacional',
  lucro_presumido:  'Lucro Presumido',
  lucro_real:       'Lucro Real',
}

function isIneligible(r: RegimeFull | { elegivel: false; motivo: string }): r is { elegivel: false; motivo: string } {
  return (r as { elegivel?: boolean }).elegivel === false
}

function bestRegimeKey(result: SimulationResult): string {
  const candidates: { key: string; profit: number }[] = []

  const sn = result.simples_nacional
  if (!isIneligible(sn)) candidates.push({ key: 'simples_nacional', profit: sn.net_profit })
  candidates.push({ key: 'lucro_presumido', profit: result.lucro_presumido.net_profit })
  candidates.push({ key: 'lucro_real',      profit: result.lucro_real.net_profit })

  return candidates.sort((a, b) => b.profit - a.profit)[0]?.key ?? 'lucro_presumido'
}

type RegimeCardProps = {
  label: string
  regime: RegimeFull | { elegivel: false; motivo: string }
  isBest: boolean
  warning?: string
}

function RegimeCard({ label, regime, isBest, warning }: RegimeCardProps) {
  if (isIneligible(regime)) {
    return (
      <div className="card p-5 flex flex-col gap-3 opacity-60">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <span className="text-sm font-semibold text-text-primary">{label}</span>
        </div>
        <p className="text-xs text-text-muted">{regime.motivo}</p>
      </div>
    )
  }

  return (
    <div className={`card p-5 flex flex-col gap-4 transition-all ${isBest ? 'border-success/50 ring-1 ring-success/20' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        {isBest && (
          <span className="flex items-center gap-1 text-xs font-medium text-success bg-success/10 px-2 py-0.5 rounded-full">
            <Trophy className="w-3 h-3" /> Melhor regime
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-text-muted mb-0.5">Imposto total</p>
          <p className="text-lg font-bold text-error">{formatCurrency(regime.total_tax)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted mb-0.5">Alíquota efetiva</p>
          <p className="text-lg font-bold text-text-primary">{formatPercent(regime.effective_rate_pct, 2)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted mb-0.5">Lucro líquido</p>
          <p className={`text-lg font-bold ${regime.net_profit >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(regime.net_profit)}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted mb-0.5">Margem líquida</p>
          <p className={`text-lg font-bold ${regime.net_margin_pct >= 0 ? 'text-success' : 'text-error'}`}>
            {formatPercent(regime.net_margin_pct, 2)}
          </p>
        </div>
      </div>

      {/* Detalhamento */}
      <div className="border-t border-border pt-3 space-y-1.5">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Detalhamento</p>
        {'das' in regime && regime.das != null ? (
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">DAS (unificado)</span>
            <span className="text-text-secondary font-medium">{formatCurrency(regime.das)}</span>
          </div>
        ) : (
          <>
            {'pis' in regime && regime.pis != null && (
              <div className="flex justify-between text-xs">
                <span className="text-text-muted">PIS</span>
                <span className="text-text-secondary font-medium">{formatCurrency(regime.pis)}</span>
              </div>
            )}
            {'cofins' in regime && regime.cofins != null && (
              <div className="flex justify-between text-xs">
                <span className="text-text-muted">COFINS</span>
                <span className="text-text-secondary font-medium">{formatCurrency(regime.cofins)}</span>
              </div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">ICMS</span>
              <span className="text-text-secondary font-medium">{formatCurrency(regime.icms)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">IRPJ + CSLL</span>
              <span className="text-text-secondary font-medium">{formatCurrency(regime.irpj_csll)}</span>
            </div>
          </>
        )}
      </div>

      {warning && (
        <p className="text-xs text-warning/80 leading-relaxed">⚠ {warning}</p>
      )}
      <p className="text-xs text-text-muted italic leading-relaxed">{regime.nota}</p>
    </div>
  )
}

export function TaxSimulator() {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [error, setError]   = useState<string | null>(null)

  const [salePrice,     setSalePrice]     = useState('74.99')
  const [cost,          setCost]          = useState('22.32')
  const [annualRevenue, setAnnualRevenue] = useState('360000')
  const [ufDestino,     setUfDestino]     = useState('RN')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const price = parseFloat(salePrice)
    const c     = parseFloat(cost)
    const rev   = parseFloat(annualRevenue)

    if (isNaN(price) || price <= 0) { setError('Preço de venda inválido.'); return }
    if (isNaN(c)     || c < 0)      { setError('Custo inválido.'); return }
    if (c > price)                  { setError('Custo não pode ser maior que o preço de venda.'); return }
    if (isNaN(rev)   || rev <= 0)   { setError('Faturamento anual inválido.'); return }

    startTransition(async () => {
      const { data, error: rpcError } = await simulateTaxes(price, c, rev, ufDestino)
      if (rpcError) { setError(rpcError); return }
      setResult(data)
    })
  }

  const best = result ? bestRegimeKey(result) : null

  return (
    <div className="space-y-5">
      {/* Formulário */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Parâmetros da simulação</h3>
        </CardHeader>
        <form onSubmit={handleSubmit} className="p-5 pt-0 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Preço de venda (R$)"
            type="number"
            min="0.01"
            step="0.01"
            value={salePrice}
            onChange={e => setSalePrice(e.target.value)}
            required
          />
          <Input
            label="Custo do produto (R$)"
            type="number"
            min="0"
            step="0.01"
            value={cost}
            onChange={e => setCost(e.target.value)}
            required
          />
          <Input
            label="Faturamento anual (R$)"
            type="number"
            min="1"
            step="1000"
            value={annualRevenue}
            onChange={e => setAnnualRevenue(e.target.value)}
            hint="Receita bruta acumulada nos últimos 12 meses"
            required
          />
          <Select
            label="UF de destino"
            value={ufDestino}
            onChange={e => setUfDestino(e.target.value)}
          >
            {UFS.map(uf => (
              <option key={uf} value={uf}>{uf}</option>
            ))}
          </Select>

          {error && (
            <div className="sm:col-span-2 p-3 rounded-lg bg-error/10 border border-error/30 text-sm text-error">
              {error}
            </div>
          )}

          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
              {isPending ? 'Calculando…' : 'Simular'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Resultados */}
      {result && (
        <>
          {/* Resumo dos inputs */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
            <span>Preço: <strong className="text-text-primary">{formatCurrency(result.inputs.sale_price)}</strong></span>
            <span>Custo: <strong className="text-text-primary">{formatCurrency(result.inputs.cost)}</strong></span>
            <span>Margem bruta: <strong className="text-text-primary">{formatPercent(result.inputs.gross_margin_pct, 1)}</strong></span>
            <span>Faturamento: <strong className="text-text-primary">{formatCurrency(result.inputs.annual_revenue)}</strong></span>
            <span>UF destino: <strong className="text-text-primary">{result.inputs.uf_destino}</strong> (ICMS {formatPercent(result.inputs.icms_rate_pct, 0)})</span>
          </div>

          {/* Cards dos 3 regimes */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <RegimeCard
              label={REGIME_LABELS.simples_nacional}
              regime={result.simples_nacional}
              isBest={best === 'simples_nacional'}
            />
            <RegimeCard
              label={REGIME_LABELS.lucro_presumido}
              regime={result.lucro_presumido}
              isBest={best === 'lucro_presumido'}
              warning="Não inclui adicional de IRPJ."
            />
            <RegimeCard
              label={REGIME_LABELS.lucro_real}
              regime={result.lucro_real}
              isBest={best === 'lucro_real'}
              warning="Estimativa conservadora: não considera créditos de PIS/COFINS."
            />
          </div>

          {/* Tabela comparativa */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-brand" />
                Comparativo resumido
              </h3>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-3 text-xs font-medium text-text-muted">Regime</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-text-muted">Imposto</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-text-muted">Alíquota efetiva</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-text-muted">Lucro líquido</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-text-muted">Margem líquida</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['simples_nacional', result.simples_nacional],
                      ['lucro_presumido',  result.lucro_presumido],
                      ['lucro_real',       result.lucro_real],
                    ] as const
                  ).map(([key, regime]) => {
                    if (isIneligible(regime)) {
                      return (
                        <tr key={key} className="border-b border-border/50 opacity-50">
                          <td className="px-5 py-3 text-text-muted">{REGIME_LABELS[key]}</td>
                          <td className="px-4 py-3 text-right text-xs text-text-muted" colSpan={4}>Não elegível</td>
                        </tr>
                      )
                    }
                    const isWinner = best === key
                    return (
                      <tr key={key} className={`border-b border-border/50 ${isWinner ? 'bg-success/5' : ''}`}>
                        <td className="px-5 py-3 font-medium text-text-primary">
                          {REGIME_LABELS[key]}
                          {isWinner && <span className="ml-2 text-xs text-success">★</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-error font-medium">{formatCurrency(regime.total_tax)}</td>
                        <td className="px-4 py-3 text-right text-text-secondary">{formatPercent(regime.effective_rate_pct, 2)}</td>
                        <td className={`px-4 py-3 text-right font-medium ${regime.net_profit >= 0 ? 'text-success' : 'text-error'}`}>
                          {formatCurrency(regime.net_profit)}
                        </td>
                        <td className={`px-5 py-3 text-right font-medium ${regime.net_margin_pct >= 0 ? 'text-success' : 'text-error'}`}>
                          {formatPercent(regime.net_margin_pct, 2)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-3 text-xs text-text-muted border-t border-border">
              Simulação gerencial. Não substitui apuração fiscal oficial. Consulte seu contador.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
