import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { DollarSign, TrendingUp, TrendingDown, Minus, Info, BarChart2 } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

// ─── Types ───────────────────────────────────────────────────────────────────

type DreRow = {
  mes:                    string
  receita_bruta:          number
  descontos:              number
  receita_liquida:        number
  cmv:                    number
  lucro_bruto:            number
  margem_bruta_pct:       number
  marketing:              number
  aluguel:                number
  salarios:               number
  operacional:            number
  impostos:               number
  frete:                  number
  outras_despesas:        number
  total_opex:             number
  outras_receitas:        number
  lucro_liquido_gerencial: number
  margem_liquida_pct:     number
  saida_caixa_estoque:    number
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function getFinancialData() {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('vw_dre_mensal')
    .select('*')
    .order('mes', { ascending: false })
    .limit(13) as unknown as { data: DreRow[] | null; error: { message: string } | null }

  if (error) {
    console.error('Erro ao carregar DRE:', error.message)
  }

  const rows = data ?? []
  const current  = rows[0]  ?? null
  const previous = rows[1]  ?? null
  const months   = rows.slice(0, 12)

  return { current, previous, months }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trendPct(current: number, previous: number) {
  if (!previous) return undefined
  return { value: ((current - previous) / previous) * 100, label: 'vs mês anterior' }
}

function fmtPct(value: number) {
  return `${value.toFixed(1)}%`
}

function marginColor(pct: number) {
  if (pct >= 20) return 'text-success'
  if (pct >= 10) return 'text-warning'
  return 'text-error'
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function FinanceiroPage() {
  await requirePageRole('gerente')
  const { current, previous, months } = await getFinancialData()

  // Mês corrente — zeros se ainda sem dados
  const receitaLiquida       = Number(current?.receita_liquida        ?? 0)
  const cmv                  = Number(current?.cmv                    ?? 0)
  const lucroBruto           = Number(current?.lucro_bruto            ?? 0)
  const margemBruta          = Number(current?.margem_bruta_pct       ?? 0)
  const totalOpex            = Number(current?.total_opex             ?? 0)
  const lucroLiquidoGerencial = Number(current?.lucro_liquido_gerencial ?? 0)
  const margemLiquida        = Number(current?.margem_liquida_pct     ?? 0)
  const saidaEstoque         = Number(current?.saida_caixa_estoque    ?? 0)

  // Mês anterior para tendências
  const prevReceita = Number(previous?.receita_liquida        ?? 0)
  const prevCmv     = Number(previous?.cmv                    ?? 0)
  const prevLucro   = Number(previous?.lucro_liquido_gerencial ?? 0)

  return (
    <div className="space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="text-sm text-muted-foreground">Regime de competência · mês atual</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/financeiro/fluxo">
            <Button variant="outline">Fluxo de Caixa</Button>
          </Link>
          <Link href="/financeiro/lucro">
            <Button variant="outline">Lucro por Venda</Button>
          </Link>
          <Link href="/financeiro/ranking">
            <Button variant="outline">Ranking de Produtos</Button>
          </Link>
          <Link href="/financeiro/clientes">
            <Button variant="outline">Lucro por Cliente</Button>
          </Link>
          <Link href="/financeiro/dre">
            <Button variant="outline">
              <BarChart2 className="mr-2 h-4 w-4" />
              DRE Completa
            </Button>
          </Link>
          <Link href="/financeiro/lancamentos">
            <Button variant="outline">Ver Lançamentos</Button>
          </Link>
          <Link href="/financeiro/lancamentos/novo">
            <Button>Lançamento</Button>
          </Link>
        </div>
      </div>

      {/* ── Bloco 1: Resultado Gerencial ──────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Resultado Gerencial — Competência
        </p>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Receita Líquida"
            value={formatCurrency(receitaLiquida)}
            icon={<TrendingUp className="h-4 w-4" />}
            trend={previous ? trendPct(receitaLiquida, prevReceita) : undefined}
          />

          <StatCard
            title="CMV (custo real vendido)"
            value={formatCurrency(cmv)}
            icon={<TrendingDown className="h-4 w-4" />}
            trend={previous ? trendPct(cmv, prevCmv) : undefined}
          />

          <StatCard
            title="Lucro Bruto"
            value={formatCurrency(lucroBruto)}
            icon={lucroBruto >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            valueClassName={lucroBruto >= 0 ? 'text-success' : 'text-error'}
          />

          <StatCard
            title="Margem Bruta"
            value={fmtPct(margemBruta)}
            icon={<DollarSign className="h-4 w-4" />}
            valueClassName={marginColor(margemBruta)}
          />

          <StatCard
            title="Despesas Operacionais"
            value={formatCurrency(totalOpex)}
            icon={<TrendingDown className="h-4 w-4" />}
          />

          <StatCard
            title="Lucro Líquido Gerencial"
            value={formatCurrency(lucroLiquidoGerencial)}
            icon={lucroLiquidoGerencial >= 0 ? <DollarSign className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            valueClassName={lucroLiquidoGerencial >= 0 ? 'text-success' : 'text-error'}
            trend={previous ? trendPct(lucroLiquidoGerencial, prevLucro) : undefined}
          />

          <StatCard
            title="Margem Líquida"
            value={fmtPct(margemLiquida)}
            icon={margemLiquida >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            valueClassName={marginColor(margemLiquida)}
          />
        </div>
      </div>

      {/* ── Bloco 2: Movimento de Caixa ───────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Movimento de Caixa
        </p>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-xl border border-border bg-bg-subtle px-4 py-4 flex items-start gap-3">
            <Info className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-secondary">Compras de Estoque</p>
              <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                Saída de caixa para formação de inventário. Não reduz o lucro líquido gerencial
                — o CMV acima já reflete o custo das peças efetivamente vendidas.
              </p>
              <p className="text-lg font-bold tabular-nums text-text-primary mt-2">
                {saidaEstoque > 0 ? formatCurrency(saidaEstoque) : '—'}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-bg-subtle px-4 py-4 flex flex-col justify-between gap-3">
            <p className="text-sm font-medium text-text-secondary">Fluxo de Caixa Detalhado</p>
            <p className="text-xs text-text-muted leading-relaxed">
              Entradas, saídas e saldo por período com visão de caixa real.
            </p>
            <Link href="/financeiro/fluxo">
              <Button variant="outline" className="w-full">Ver Fluxo de Caixa</Button>
            </Link>
          </div>

          <div className="rounded-xl border border-border bg-bg-subtle px-4 py-4 flex flex-col justify-between gap-3">
            <p className="text-sm font-medium text-text-secondary">DRE Gerencial Completa</p>
            <p className="text-xs text-text-muted leading-relaxed">
              Demonstrativo mensal com navegação por período, breakdown por categoria e margem.
            </p>
            <Link href="/financeiro/dre">
              <Button variant="outline" className="w-full">
                <BarChart2 className="mr-2 h-4 w-4" />
                Abrir DRE
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* ── Tabela histórica ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">DRE — Últimos 12 meses</h2>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          {months.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Nenhum dado encontrado.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mês</TableHead>
                  <TableHead>Receita Líquida</TableHead>
                  <TableHead>CMV</TableHead>
                  <TableHead>Lucro Bruto</TableHead>
                  <TableHead>Margem Bruta</TableHead>
                  <TableHead>Despesas Op.</TableHead>
                  <TableHead>Lucro Líquido</TableHead>
                  <TableHead>Margem Líq.</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {months.map((m) => {
                  const rl  = Number(m.receita_liquida        ?? 0)
                  const c   = Number(m.cmv                    ?? 0)
                  const lb  = Number(m.lucro_bruto            ?? 0)
                  const mb  = Number(m.margem_bruta_pct       ?? 0)
                  const op  = Number(m.total_opex             ?? 0)
                  const ll  = Number(m.lucro_liquido_gerencial ?? 0)
                  const ml  = Number(m.margem_liquida_pct     ?? 0)

                  return (
                    <TableRow key={m.mes}>
                      <TableCell>{formatDate(m.mes, 'MMM yyyy')}</TableCell>
                      <TableCell>{formatCurrency(rl)}</TableCell>
                      <TableCell>{formatCurrency(c)}</TableCell>
                      <TableCell className={lb >= 0 ? 'text-success' : 'text-error'}>
                        {formatCurrency(lb)}
                      </TableCell>
                      <TableCell className={marginColor(mb)}>
                        {fmtPct(mb)}
                      </TableCell>
                      <TableCell>{formatCurrency(op)}</TableCell>
                      <TableCell className={ll >= 0 ? 'text-success' : 'text-error'}>
                        {formatCurrency(ll)}
                      </TableCell>
                      <TableCell className={marginColor(ml)}>
                        {fmtPct(ml)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
