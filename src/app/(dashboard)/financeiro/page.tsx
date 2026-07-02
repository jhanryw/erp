import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { DollarSign, TrendingUp, TrendingDown, Minus, BarChart2, ShoppingBag, Users, Receipt, Package } from 'lucide-react'

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
  mes:                     string
  receita_bruta:           number
  descontos:               number
  receita_liquida:         number
  cmv:                     number
  lucro_bruto:             number
  margem_bruta_pct:        number
  marketing:               number
  aluguel:                 number
  salarios:                number
  operacional:             number
  impostos:                number
  frete:                   number
  outras_despesas:         number
  total_opex:              number
  outras_receitas:         number
  lucro_liquido_gerencial: number
  margem_liquida_pct:      number
  saida_caixa_estoque:     number
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function monthBounds(mesIso: string) {
  // mesIso = '2026-07-01'
  const [y, m] = mesIso.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return {
    start: mesIso,
    end: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  }
}

async function getFinancialData() {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('vw_dre_mensal')
    .select('*')
    .order('mes', { ascending: false })
    .limit(13) as unknown as { data: DreRow[] | null; error: { message: string } | null }

  if (error) console.error('Erro ao carregar DRE:', error.message)

  const rows = (data ?? []).filter((r) =>
    Number(r.receita_liquida)    !== 0 ||
    Number(r.cmv)                !== 0 ||
    Number(r.total_opex)         !== 0 ||
    Number(r.outras_receitas)    !== 0 ||
    Number(r.saida_caixa_estoque) !== 0
  )

  const current  = rows[0] ?? null
  const previous = rows[1] ?? null
  const months   = rows.slice(0, 12)

  // KPIs operacionais do mês corrente (contagem de vendas e clientes)
  let totalVendas    = 0
  let uniqueClientes = 0

  if (current?.mes) {
    const { start, end } = monthBounds(current.mes)
    const { data: salesData } = await supabase
      .from('sales')
      .select('id, customer_id')
      .gte('sale_date', start)
      .lte('sale_date', end)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: { id: number; customer_id: number | null }[] | null
        error: unknown
      }

    const salesList = salesData ?? []
    totalVendas    = salesList.length
    uniqueClientes = new Set(salesList.map((s) => s.customer_id).filter(Boolean)).size
  }

  return { current, previous, months, totalVendas, uniqueClientes }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trendPct(current: number, previous: number) {
  if (!previous) return undefined
  return { value: ((current - previous) / previous) * 100, label: 'vs mês anterior' }
}

function fmtPct(value: number, hasRevenue: boolean) {
  if (!hasRevenue) return '—'
  return `${value.toFixed(1)}%`
}

function marginColor(pct: number, hasRevenue: boolean) {
  if (!hasRevenue) return 'text-text-muted'
  if (pct >= 20) return 'text-success'
  if (pct >= 10) return 'text-warning'
  return 'text-error'
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function FinanceiroPage() {
  await requirePageRole('gerente')
  const { current, previous, months, totalVendas, uniqueClientes } = await getFinancialData()

  const rl   = Number(current?.receita_liquida         ?? 0)
  const cmv  = Number(current?.cmv                     ?? 0)
  const lb   = Number(current?.lucro_bruto             ?? 0)
  const mb   = Number(current?.margem_bruta_pct        ?? 0)
  const opex = Number(current?.total_opex              ?? 0)
  const ll   = Number(current?.lucro_liquido_gerencial ?? 0)
  const ml   = Number(current?.margem_liquida_pct      ?? 0)
  const se   = Number(current?.saida_caixa_estoque     ?? 0)
  const hr   = rl > 0

  const prevRl = Number(previous?.receita_liquida         ?? 0)
  const prevLl = Number(previous?.lucro_liquido_gerencial ?? 0)

  // KPIs derivados
  const ticketMedio    = totalVendas > 0 ? rl / totalVendas : 0
  const lucroPorVenda  = totalVendas > 0 ? ll / totalVendas : 0
  const cmvPct         = hr ? (cmv  / rl) * 100 : 0
  const opexPct        = hr ? (opex / rl) * 100 : 0

  return (
    <div className="space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="text-sm text-muted-foreground">Regime de competência · mês atual</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/financeiro/dre">
            <Button variant="outline" size="sm">
              <BarChart2 className="mr-1.5 h-3.5 w-3.5" />
              DRE Completa
            </Button>
          </Link>
          <Link href="/financeiro/fluxo">
            <Button variant="outline" size="sm">Fluxo de Caixa</Button>
          </Link>
          <Link href="/financeiro/lucro">
            <Button variant="outline" size="sm">Lucro por Venda</Button>
          </Link>
          <Link href="/financeiro/ranking">
            <Button variant="outline" size="sm">Ranking</Button>
          </Link>
          <Link href="/financeiro/clientes">
            <Button variant="outline" size="sm">Por Cliente</Button>
          </Link>
          <Link href="/financeiro/lancamentos">
            <Button variant="outline" size="sm">Lançamentos</Button>
          </Link>
          <Link href="/financeiro/lancamentos/novo">
            <Button size="sm">+ Lançamento</Button>
          </Link>
        </div>
      </div>

      {/* ── Bloco 1: Resultado Gerencial ────────────────────────────────────── */}
      <section>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-3">
          Resultado Gerencial — Competência
        </p>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <StatCard
            title="Receita Líquida"
            value={formatCurrency(rl)}
            icon={<TrendingUp className="h-4 w-4" />}
            trend={previous ? trendPct(rl, prevRl) : undefined}
          />

          <StatCard
            title="CMV"
            value={formatCurrency(cmv)}
            subtitle="custo real vendido"
            icon={<Package className="h-4 w-4" />}
          />

          <StatCard
            title="Lucro Bruto"
            value={formatCurrency(lb)}
            icon={lb >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            valueClassName={hr ? (lb >= 0 ? 'text-success' : 'text-error') : undefined}
          />

          <StatCard
            title="Margem Bruta"
            value={fmtPct(mb, hr)}
            icon={<DollarSign className="h-4 w-4" />}
            valueClassName={marginColor(mb, hr)}
          />

          <StatCard
            title="Despesas Operacionais"
            value={formatCurrency(opex)}
            icon={<TrendingDown className="h-4 w-4" />}
          />

          <StatCard
            title="Lucro Líquido Gerencial"
            value={formatCurrency(ll)}
            icon={ll >= 0 ? <DollarSign className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            valueClassName={hr ? (ll >= 0 ? 'text-success' : 'text-error') : undefined}
            trend={previous ? trendPct(ll, prevLl) : undefined}
          />

          <StatCard
            title="Margem Líquida"
            value={fmtPct(ml, hr)}
            icon={ml >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            valueClassName={marginColor(ml, hr)}
          />

          <StatCard
            title="Compras de Estoque"
            value={se > 0 ? formatCurrency(se) : '—'}
            subtitle="saída de caixa · fora da DRE"
            icon={<ShoppingBag className="h-4 w-4" />}
          />
        </div>
      </section>

      {/* ── Bloco 2: Eficiência Operacional ─────────────────────────────────── */}
      <section>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-3">
          Eficiência Operacional — Mês Atual
        </p>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <StatCard
            title="Vendas no Mês"
            value={String(totalVendas)}
            icon={<Receipt className="h-4 w-4" />}
          />

          <StatCard
            title="Clientes Atendidos"
            value={String(uniqueClientes)}
            icon={<Users className="h-4 w-4" />}
          />

          <StatCard
            title="Ticket Médio"
            value={totalVendas > 0 ? formatCurrency(ticketMedio) : '—'}
            subtitle="receita líquida / vendas"
            icon={<DollarSign className="h-4 w-4" />}
          />

          <StatCard
            title="Lucro por Venda"
            value={totalVendas > 0 ? formatCurrency(lucroPorVenda) : '—'}
            subtitle="lucro líquido / vendas"
            icon={lucroPorVenda >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            valueClassName={totalVendas > 0 ? (lucroPorVenda >= 0 ? 'text-success' : 'text-error') : undefined}
          />

          <StatCard
            title="CMV %"
            value={fmtPct(cmvPct, hr)}
            subtitle="% da receita líquida"
            icon={<Package className="h-4 w-4" />}
            valueClassName={hr ? (cmvPct <= 40 ? 'text-success' : cmvPct <= 60 ? 'text-warning' : 'text-error') : undefined}
          />

          <StatCard
            title="Despesas Op. %"
            value={fmtPct(opexPct, hr)}
            subtitle="% da receita líquida"
            icon={<TrendingDown className="h-4 w-4" />}
            valueClassName={hr ? (opexPct <= 20 ? 'text-success' : opexPct <= 35 ? 'text-warning' : 'text-error') : undefined}
          />
        </div>
      </section>

      {/* ── Tabela histórica ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold">Histórico — Últimos 12 meses</h2>
            <span className="text-xs text-text-muted">meses sem movimento são omitidos</span>
          </div>
        </CardHeader>

        <CardContent className="overflow-x-auto p-0">
          {months.length === 0 ? (
            <p className="text-sm text-muted-foreground px-6 py-4">Nenhum dado encontrado.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mês</TableHead>
                  <TableHead>Receita Líq.</TableHead>
                  <TableHead>CMV</TableHead>
                  <TableHead>Lucro Bruto</TableHead>
                  <TableHead>Mg. Bruta</TableHead>
                  <TableHead>Desp. Op.</TableHead>
                  <TableHead>Lucro Líq.</TableHead>
                  <TableHead>Mg. Líq.</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {months.map((m) => {
                  const mrl = Number(m.receita_liquida         ?? 0)
                  const mc  = Number(m.cmv                     ?? 0)
                  const mlb = Number(m.lucro_bruto             ?? 0)
                  const mmb = Number(m.margem_bruta_pct        ?? 0)
                  const mop = Number(m.total_opex              ?? 0)
                  const mll = Number(m.lucro_liquido_gerencial ?? 0)
                  const mml = Number(m.margem_liquida_pct      ?? 0)
                  const mhr = mrl > 0

                  return (
                    <TableRow key={m.mes}>
                      <TableCell className="font-medium">{formatDate(m.mes, 'MMM yyyy')}</TableCell>
                      <TableCell>{formatCurrency(mrl)}</TableCell>
                      <TableCell>{formatCurrency(mc)}</TableCell>
                      <TableCell className={mhr ? (mlb >= 0 ? 'text-success' : 'text-error') : 'text-text-muted'}>
                        {formatCurrency(mlb)}
                      </TableCell>
                      <TableCell className={marginColor(mmb, mhr)}>
                        {fmtPct(mmb, mhr)}
                      </TableCell>
                      <TableCell>{formatCurrency(mop)}</TableCell>
                      <TableCell className={mhr ? (mll >= 0 ? 'text-success' : 'text-error') : 'text-text-muted'}>
                        {formatCurrency(mll)}
                      </TableCell>
                      <TableCell className={marginColor(mml, mhr)}>
                        {fmtPct(mml, mhr)}
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
