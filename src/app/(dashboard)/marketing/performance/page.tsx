import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Info, TrendingUp } from 'lucide-react'

import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createAdminClient } from '@/lib/supabase/admin'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { StatCard } from '@/components/ui/stat-card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { ORIGIN_LABELS, ORIGIN_COLORS } from '@/lib/constants/origins'

export const dynamic = 'force-dynamic'

// ─── Helpers de data ────────────────────────────────────────────────────────

function currentYM(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthBounds(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return {
    start: `${ym}-01`,
    end:   `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`,
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

// ─── Labels de categoria de marketing ───────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  paid_traffic:         'Tráfego Pago',
  influencers:          'Influenciadores',
  events:               'Eventos',
  photos:               'Fotos / Conteúdo',
  gifts:                'Brindes',
  packaging:            'Embalagens',
  content:              'Produção de Conteúdo',
  design:               'Design',
  tools:                'Ferramentas',
  crm_automation:       'CRM / Automação',
  website_landing_page: 'Site / Landing Page',
  agency_freelancer:    'Agência / Freelancer',
  other:                'Outros',
}

// ─── Types ──────────────────────────────────────────────────────────────────

type RawSale = {
  total:           number
  subtotal:        number
  discount_amount: number
  cashback_used:   number | null
  sale_origin:     string | null
  sale_items:      { unit_cost: number; quantity: number }[]
}

type RawCost = {
  category:    string
  amount:      number
  campaign_id: number | null
}

type RawCampaign = {
  id:      number
  name:    string
  channel: string | null
  budget:  number | null
  active:  boolean
}

// ─── Data ───────────────────────────────────────────────────────────────────

async function getPerformanceData(ym: string) {
  const admin = createAdminClient()
  const { start, end } = monthBounds(ym)

  const [salesRes, costsRes, campaignsRes] = await Promise.all([
    // Vendas do período com itens (para CMV)
    admin
      .from('sales')
      .select('total, subtotal, discount_amount, cashback_used, sale_origin, sale_items(unit_cost, quantity)')
      .gte('sale_date', start)
      .lte('sale_date', end)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: RawSale[] | null
        error: { message: string } | null
      },

    // Custos de marketing do período (fonte única — não usar finance_entries para evitar dupla contagem)
    admin
      .from('marketing_costs')
      .select('category, amount, campaign_id')
      .gte('cost_date', start)
      .lte('cost_date', end) as unknown as {
        data: RawCost[] | null
        error: { message: string } | null
      },

    // Campanhas ativas (informativo — sem ROAS por campanha ainda)
    admin
      .from('campaigns')
      .select('id, name, channel, budget, active')
      .eq('active', true)
      .order('name') as unknown as {
        data: RawCampaign[] | null
        error: { message: string } | null
      },
  ])

  const sales     = salesRes.data     ?? []
  const costs     = costsRes.data     ?? []
  const campaigns = campaignsRes.data ?? []

  // ── Métricas globais ──────────────────────────────────────────────────────

  let receitaBruta   = 0
  let descontos      = 0
  let cmv            = 0
  let totalVendas    = 0

  const byChannel: Record<string, { receita: number; vendas: number; cmv: number }> = {}

  for (const sale of sales) {
    const rec = Number(sale.subtotal)
    const desc = Number(sale.discount_amount) + Number(sale.cashback_used ?? 0)
    let saleCmv = 0
    for (const item of sale.sale_items ?? []) {
      saleCmv += Number(item.unit_cost) * Number(item.quantity)
    }

    receitaBruta += rec
    descontos    += desc
    cmv          += saleCmv
    totalVendas  += 1

    const origin = sale.sale_origin ?? 'unknown'
    if (!byChannel[origin]) byChannel[origin] = { receita: 0, vendas: 0, cmv: 0 }
    byChannel[origin].receita += rec - desc
    byChannel[origin].vendas  += 1
    byChannel[origin].cmv     += saleCmv
  }

  const receitaLiquida   = receitaBruta - descontos
  const lucroBruto       = receitaLiquida - cmv

  // ── Investimento ─────────────────────────────────────────────────────────

  let investimentoTotal = 0
  const byCategory: Record<string, number> = {}
  const costsByCampaign: Record<number, number> = {}

  for (const cost of costs) {
    const amt = Number(cost.amount)
    investimentoTotal          += amt
    byCategory[cost.category]   = (byCategory[cost.category] ?? 0) + amt
    if (cost.campaign_id != null) {
      costsByCampaign[cost.campaign_id] = (costsByCampaign[cost.campaign_id] ?? 0) + amt
    }
  }

  // ── KPIs ─────────────────────────────────────────────────────────────────

  const mer  = investimentoTotal > 0 ? receitaLiquida  / investimentoTotal : null
  const poas = investimentoTotal > 0 ? lucroBruto      / investimentoTotal : null

  // ── Canais ordenados por receita ─────────────────────────────────────────

  const channels = Object.entries(byChannel)
    .map(([origin, d]) => ({
      origin,
      label:       ORIGIN_LABELS[origin] ?? origin,
      color:       ORIGIN_COLORS[origin] ?? ORIGIN_COLORS.other,
      receita:     d.receita,
      vendas:      d.vendas,
      ticket:      d.vendas > 0 ? d.receita / d.vendas : 0,
      lucroBruto:  d.receita - d.cmv,
      pctReceita:  receitaLiquida > 0 ? (d.receita / receitaLiquida) * 100 : 0,
    }))
    .sort((a, b) => b.receita - a.receita)

  // ── Categorias de investimento ordenadas ─────────────────────────────────

  const categoryRows = Object.entries(byCategory)
    .map(([cat, amt]) => ({
      category: cat,
      label:    CATEGORY_LABELS[cat] ?? cat,
      amount:   amt,
      pct:      investimentoTotal > 0 ? (amt / investimentoTotal) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)

  // ── Campanhas com custo no período ───────────────────────────────────────

  const campaignRows = campaigns.map(c => ({
    ...c,
    costoPeriodo: costsByCampaign[c.id] ?? 0,
  }))

  return {
    receitaBruta, descontos, receitaLiquida,
    cmv, lucroBruto, totalVendas,
    investimentoTotal, mer, poas,
    channels, categoryRows, campaignRows,
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtMer(v: number | null) {
  if (v === null) return '—'
  return `${v.toFixed(2)}×`
}

function fmtPoas(v: number | null) {
  if (v === null) return '—'
  return `${v.toFixed(2)}×`
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function MarketingPerformancePage({
  searchParams,
}: {
  searchParams: { month?: string }
}) {
  await requirePageRole('gerente')

  const ym        = /^\d{4}-\d{2}$/.test(searchParams.month ?? '') ? searchParams.month! : currentYM()
  const prevMonth = shiftMonth(ym, -1)
  const nextMonth = shiftMonth(ym, +1)
  const data      = await getPerformanceData(ym)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/marketing">
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Performance de Marketing</h1>
            <p className="text-sm text-text-muted">Métricas gerenciais · regime de competência</p>
          </div>
        </div>

        {/* Navegação de mês */}
        <div className="flex items-center gap-2">
          <Link href={`/marketing/performance?month=${prevMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </Link>
          <span className="text-sm font-medium text-text-primary capitalize w-36 text-center">
            {monthLabel(ym)}
          </span>
          <Link href={`/marketing/performance?month=${nextMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </div>

      {/* Aviso metodológico */}
      <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-subtle px-4 py-3">
        <Info className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
        <p className="text-sm text-text-muted leading-relaxed">
          <strong className="text-text-secondary">Métricas macro desta versão:</strong>{' '}
          MER e POAS são calculados usando o investimento total de marketing do período contra
          a receita/lucro total do período, sem atribuição por campanha. A atribuição
          venda → campanha específica será implementada em uma etapa futura.
          Investimento baseado exclusivamente em <strong>Custos de Marketing</strong> cadastrados
          — lançamentos em Financeiro não são somados para evitar dupla contagem.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          title="Investimento em Marketing"
          value={formatCurrency(data.investimentoTotal)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle={data.investimentoTotal === 0 ? 'Nenhum custo lançado no período' : undefined}
        />
        <StatCard
          title="Receita Líquida"
          value={formatCurrency(data.receitaLiquida)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle={`${data.totalVendas} venda${data.totalVendas !== 1 ? 's' : ''} no período`}
        />
        <StatCard
          title="MER"
          value={fmtMer(data.mer)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Receita líquida / investimento"
        />
        <StatCard
          title="Lucro Bruto"
          value={formatCurrency(data.lucroBruto)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Receita líquida − CMV"
        />
        <StatCard
          title="POAS"
          value={fmtPoas(data.poas)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Lucro bruto / investimento"
        />
        <StatCard
          title="CMV no Período"
          value={formatCurrency(data.cmv)}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Custo médio × qtd vendida"
        />
      </div>

      {/* Receita por Canal */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Receita por Canal de Origem</h2>
          <p className="text-sm text-text-muted mt-1">
            Agrupado por <code className="text-xs bg-bg-subtle px-1 py-0.5 rounded">sale_origin</code> registrado na venda
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {data.channels.length === 0 ? (
            <p className="text-sm text-text-muted py-4">Nenhuma venda no período.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-3 pr-4 font-medium text-text-muted">Canal</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted text-right">Receita Líquida</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted text-right">Vendas</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted text-right">Ticket Médio</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted text-right">Lucro Bruto</th>
                    <th className="pb-3 font-medium text-text-muted text-right">% Receita</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((ch) => (
                    <tr key={ch.origin} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-4">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: ch.color }}
                        >
                          {ch.label}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums font-medium">
                        {formatCurrency(ch.receita)}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-text-secondary">
                        {ch.vendas}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-text-secondary">
                        {formatCurrency(ch.ticket)}
                      </td>
                      <td className={`py-3 pr-4 text-right tabular-nums ${ch.lucroBruto >= 0 ? 'text-success' : 'text-error'}`}>
                        {formatCurrency(ch.lucroBruto)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-text-muted">
                        {ch.pctReceita.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border">
                    <td className="pt-3 pr-4 font-semibold text-text-primary">Total</td>
                    <td className="pt-3 pr-4 text-right tabular-nums font-semibold">
                      {formatCurrency(data.receitaLiquida)}
                    </td>
                    <td className="pt-3 pr-4 text-right tabular-nums font-semibold">
                      {data.totalVendas}
                    </td>
                    <td className="pt-3 pr-4 text-right tabular-nums text-text-muted">
                      {data.totalVendas > 0 ? formatCurrency(data.receitaLiquida / data.totalVendas) : '—'}
                    </td>
                    <td className={`pt-3 pr-4 text-right tabular-nums font-semibold ${data.lucroBruto >= 0 ? 'text-success' : 'text-error'}`}>
                      {formatCurrency(data.lucroBruto)}
                    </td>
                    <td className="pt-3 text-right tabular-nums text-text-muted">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Investimento por Categoria */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Investimento por Categoria</h2>
          <p className="text-sm text-text-muted mt-1">
            Baseado em <strong>Custos de Marketing</strong> cadastrados no período
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {data.categoryRows.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              Nenhum custo de marketing lançado no período.{' '}
              <Link href="/marketing/custos/novo" className="text-brand hover:underline">
                Lançar custo
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {data.categoryRows.map((row) => (
                <div key={row.category} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-text-secondary truncate">
                        {row.label}
                      </span>
                      <span className="text-sm tabular-nums text-text-primary ml-4 shrink-0">
                        {formatCurrency(row.amount)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-bg-subtle rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand/70 rounded-full"
                        style={{ width: `${Math.min(row.pct, 100)}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-xs tabular-nums text-text-muted w-10 text-right shrink-0">
                    {row.pct.toFixed(0)}%
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-3 border-t border-border mt-4">
                <span className="text-sm font-semibold text-text-primary">Total</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatCurrency(data.investimentoTotal)}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Campanhas ativas */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Campanhas Ativas</h2>
              <p className="text-sm text-text-muted mt-1">
                Custo vinculado à campanha no período · ROAS por campanha disponível em versão futura
              </p>
            </div>
            <Link href="/marketing/campanhas">
              <button className="text-sm text-brand hover:underline">
                Gerenciar campanhas
              </button>
            </Link>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {data.campaignRows.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              Nenhuma campanha ativa.{' '}
              <Link href="/marketing/campanhas" className="text-brand hover:underline">
                Criar campanha
              </Link>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-3 pr-4 font-medium text-text-muted">Campanha</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted">Canal</th>
                    <th className="pb-3 pr-4 font-medium text-text-muted text-right">Budget</th>
                    <th className="pb-3 font-medium text-text-muted text-right">Custo no Período</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaignRows.map((c) => (
                    <tr key={c.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-4 font-medium text-text-primary">{c.name}</td>
                      <td className="py-3 pr-4">
                        {c.channel ? (
                          <Badge variant="secondary" className="capitalize">{c.channel}</Badge>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-text-secondary">
                        {c.budget != null ? formatCurrency(c.budget) : '—'}
                      </td>
                      <td className="py-3 text-right tabular-nums font-medium">
                        {c.costoPeriodo > 0 ? formatCurrency(c.costoPeriodo) : (
                          <span className="text-text-muted">Sem custo vinculado</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
