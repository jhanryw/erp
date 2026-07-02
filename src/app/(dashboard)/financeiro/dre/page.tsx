import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Info } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

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

function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return {
    start: `${ym}-01`,
    end:   `${ym}-${String(lastDay).padStart(2, '0')}`,
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year:  'numeric',
  })
}

// ─── Types ──────────────────────────────────────────────────────────────────

type RawSale = {
  subtotal:        number
  discount_amount: number
  cashback_used:   number
  sale_items:      { unit_cost: number; quantity: number }[]
}

type RawEntry = {
  category: string
  amount:   number
}

// ─── Data ───────────────────────────────────────────────────────────────────

async function getDreData(ym: string) {
  const admin = createAdminClient()
  const { start, end } = monthBounds(ym)

  const [salesRes, entriesRes] = await Promise.all([
    admin
      .from('sales')
      .select('subtotal, discount_amount, cashback_used, sale_items(unit_cost, quantity)')
      .gte('sale_date', start)
      .lte('sale_date', end)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: RawSale[] | null
        error: { message: string } | null
      },

    // Exclui 'sale' para não duplicar receita
    admin
      .from('finance_entries')
      .select('category, amount')
      .gte('reference_date', start)
      .lte('reference_date', end)
      .not('category', 'eq', 'sale') as unknown as {
        data: RawEntry[] | null
        error: { message: string } | null
      },
  ])

  // ── Bloco 1: Receita ──────────────────────────────────────────────────────
  let receitaBruta = 0
  let descontos    = 0
  let cmv          = 0

  for (const sale of salesRes.data ?? []) {
    receitaBruta += Number(sale.subtotal)
    descontos    += Number(sale.discount_amount) + Number(sale.cashback_used)
    for (const item of sale.sale_items ?? []) {
      cmv += Number(item.unit_cost) * Number(item.quantity)
    }
  }

  const receitaLiquida = receitaBruta - descontos

  // ── Bloco 2: Custo ────────────────────────────────────────────────────────
  const lucroBruto   = receitaLiquida - cmv
  const margemBruta  = receitaLiquida > 0 ? (lucroBruto / receitaLiquida) * 100 : 0

  // ── Bloco 3: Despesas operacionais ───────────────────────────────────────
  const expMap: Record<string, number> = {
    marketing:     0,
    rent:          0,
    salaries:      0,
    operational:   0,
    taxes:         0,
    freight_cost:  0,
    other_expense: 0,
    other_income:  0,
    // separado — não entra no DRE
    stock_purchase: 0,
  }

  for (const e of entriesRes.data ?? []) {
    if (e.category in expMap) expMap[e.category] += Number(e.amount)
  }

  const totalDespesasOp =
    expMap.marketing + expMap.rent + expMap.salaries +
    expMap.operational + expMap.taxes + expMap.freight_cost + expMap.other_expense

  const resultadoOperacional = lucroBruto - totalDespesasOp
  const margemOp = receitaLiquida > 0 ? (resultadoOperacional / receitaLiquida) * 100 : 0

  // ── Bloco 4: Lucro Líquido Gerencial (competência pura) ──────────────────
  // stock_purchase NÃO entra aqui — é saída de caixa, não despesa do período.
  const outrasReceitas       = expMap.other_income
  const lucroLiquidoGerencial = resultadoOperacional + outrasReceitas
  const margemLiquida         = receitaLiquida > 0 ? (lucroLiquidoGerencial / receitaLiquida) * 100 : 0

  // Saída de caixa para estoque — exibido separado, fora da DRE
  const saidaCaixaEstoque = expMap.stock_purchase

  return {
    receitaBruta,
    descontos,
    receitaLiquida,
    cmv,
    lucroBruto,
    margemBruta,
    despesas: {
      marketing:     expMap.marketing,
      rent:          expMap.rent,
      salaries:      expMap.salaries,
      operational:   expMap.operational,
      taxes:         expMap.taxes,
      freight_cost:  expMap.freight_cost,
      other_expense: expMap.other_expense,
    },
    totalDespesasOp,
    resultadoOperacional,
    margemOp,
    outrasReceitas,
    lucroLiquidoGerencial,
    margemLiquida,
    saidaCaixaEstoque,
  }
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────

function DreRow({
  label,
  value,
  muted = false,
  prefix = '',
}: {
  label:   string
  value:   number
  muted?:  boolean
  prefix?: string
}) {
  const valueClass = muted
    ? 'text-text-muted'
    : value < 0
    ? 'text-error'
    : 'text-text-primary'

  return (
    <div className={`flex items-center justify-between py-2 ${muted ? 'text-sm' : ''}`}>
      <span className={muted ? 'text-text-muted' : 'text-text-secondary'}>
        {prefix} {label}
      </span>
      <span className={`tabular-nums font-medium ${valueClass}`}>
        {formatCurrency(value)}
      </span>
    </div>
  )
}

function MargemBadge({ value }: { value: number }) {
  return (
    <span
      className={`ml-2 text-xs font-semibold px-2 py-0.5 rounded-full ${
        value >= 0
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      }`}
    >
      {value.toFixed(1)}%
    </span>
  )
}

function ResultRow({
  label,
  value,
  margin,
}: {
  label:  string
  value:  number
  margin: number
}) {
  return (
    <div className="flex items-center justify-between pt-3 mt-1 border-t border-border">
      <span className="font-bold text-text-primary">
        {label}
        <MargemBadge value={margin} />
      </span>
      <span className={`tabular-nums text-lg font-bold ${value >= 0 ? 'text-success' : 'text-error'}`}>
        {formatCurrency(value)}
      </span>
    </div>
  )
}

function Separator() {
  return <div className="border-t border-border my-1" />
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function DrePage({
  searchParams,
}: {
  searchParams: { month?: string }
}) {
  const ym = /^\d{4}-\d{2}$/.test(searchParams.month ?? '')
    ? searchParams.month!
    : currentYM()

  const data       = await getDreData(ym)
  const prevMonth  = shiftMonth(ym, -1)
  const nextMonth  = shiftMonth(ym, +1)

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/financeiro">
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">DRE — Demonstração do Resultado</h2>
            <p className="text-sm text-text-muted">Regime de competência · gerencial</p>
          </div>
        </div>

        {/* Navegação de mês */}
        <div className="flex items-center gap-2">
          <Link href={`/financeiro/dre?month=${prevMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </Link>
          <span className="text-sm font-medium text-text-primary capitalize w-36 text-center">
            {monthLabel(ym)}
          </span>
          <Link href={`/financeiro/dre?month=${nextMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </div>

      {/* ── BLOCO 1: Receita ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Receita</p>
        </CardHeader>
        <CardContent className="pt-0">
          <DreRow label="Receita Bruta"          value={data.receitaBruta} />
          <DreRow label="Descontos e Cashback"   value={-data.descontos}   muted prefix="(−)" />
          <Separator />
          <div className="flex items-center justify-between pt-2">
            <span className="font-semibold text-text-primary">Receita Líquida</span>
            <span className="tabular-nums font-semibold text-text-primary text-base">
              {formatCurrency(data.receitaLiquida)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── BLOCO 2: Custo dos Produtos Vendidos (CMV) ─────────────────────── */}
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Custo dos Produtos Vendidos
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <DreRow
            label="CMV — Custo Médio × Quantidade Vendida"
            value={-data.cmv}
            muted
            prefix="(−)"
          />
          <ResultRow label="Lucro Bruto" value={data.lucroBruto} margin={data.margemBruta} />
        </CardContent>
      </Card>

      {/* ── BLOCO 3: Despesas Operacionais ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Despesas Operacionais
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <DreRow label="Marketing"       value={-data.despesas.marketing}     muted prefix="(−)" />
          <DreRow label="Aluguel"         value={-data.despesas.rent}          muted prefix="(−)" />
          <DreRow label="Salários"        value={-data.despesas.salaries}      muted prefix="(−)" />
          <DreRow label="Operacional"     value={-data.despesas.operational}   muted prefix="(−)" />
          <DreRow label="Impostos"        value={-data.despesas.taxes}         muted prefix="(−)" />
          <DreRow label="Frete (custo)"   value={-data.despesas.freight_cost}  muted prefix="(−)" />
          <DreRow label="Outras Despesas" value={-data.despesas.other_expense} muted prefix="(−)" />
          <ResultRow
            label="Resultado Operacional"
            value={data.resultadoOperacional}
            margin={data.margemOp}
          />
        </CardContent>
      </Card>

      {/* ── BLOCO 4: Lucro Líquido Gerencial ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Resultado Final
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {data.outrasReceitas > 0 && (
            <DreRow label="Outras Receitas" value={data.outrasReceitas} prefix="(+)" />
          )}
          <ResultRow
            label="Lucro Líquido Gerencial"
            value={data.lucroLiquidoGerencial}
            margin={data.margemLiquida}
          />
        </CardContent>
      </Card>

      {/* ── INFORMATIVO DE CAIXA (fora da DRE) ────────────────────────────── */}
      {data.saidaCaixaEstoque > 0 && (
        <div className="rounded-xl border border-border bg-bg-subtle px-4 py-4">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-secondary">
                Compras de Estoque — saída de caixa para formação de inventário
              </p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                Este valor representa entradas de mercadoria registradas no período.
                Não é uma despesa por competência porque a mercadoria ainda pode estar
                em estoque — o custo só é reconhecido como CMV quando a venda acontece.
                Aparece separado para não distorcer o Lucro Líquido Gerencial.
              </p>
            </div>
            <span className="tabular-nums font-semibold text-text-secondary whitespace-nowrap">
              {formatCurrency(data.saidaCaixaEstoque)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
