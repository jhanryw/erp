import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Info } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'
import type { VwDreMensal } from '@/types/database.types'

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

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year:  'numeric',
  })
}

// ─── Data ───────────────────────────────────────────────────────────────────

type DreData = Omit<VwDreMensal, 'mes' | 'company_id'>

const EMPTY_DRE_DATA: DreData = {
  receita_bruta: 0,
  descontos: 0,
  receita_liquida: 0,
  cmv: 0,
  lucro_bruto: 0,
  margem_bruta_pct: 0,
  marketing: 0,
  aluguel: 0,
  salarios: 0,
  operacional: 0,
  impostos: 0,
  frete: 0,
  outras_despesas: 0,
  total_opex: 0,
  resultado_operacional: 0,
  margem_operacional_pct: 0,
  outras_receitas: 0,
  lucro_liquido_gerencial: 0,
  margem_liquida_pct: 0,
  saida_caixa_estoque: 0,
}

async function getDreData(ym: string, companyId: number): Promise<DreData> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('vw_dre_mensal')
    .select('*')
    .eq('company_id', companyId)
    .eq('mes', `${ym}-01`)
    .maybeSingle() as unknown as { data: VwDreMensal | null; error: { message: string } | null }

  if (error) {
    console.error('Erro ao buscar DRE:', error.message)
    return EMPTY_DRE_DATA
  }

  return data ?? EMPTY_DRE_DATA
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
  const profile = await requirePageRole('gerente')

  const ym = /^\d{4}-\d{2}$/.test(searchParams.month ?? '')
    ? searchParams.month!
    : currentYM()

  const data       = profile.company_id ? await getDreData(ym, profile.company_id) : EMPTY_DRE_DATA
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
          <DreRow label="Receita Bruta"          value={data.receita_bruta} />
          <DreRow label="Descontos e Cashback"   value={-data.descontos}    muted prefix="(−)" />
          <Separator />
          <div className="flex items-center justify-between pt-2">
            <span className="font-semibold text-text-primary">Receita Líquida</span>
            <span className="tabular-nums font-semibold text-text-primary text-base">
              {formatCurrency(data.receita_liquida)}
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
          <ResultRow label="Lucro Bruto" value={data.lucro_bruto} margin={data.margem_bruta_pct} />
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
          <DreRow label="Marketing"       value={-data.marketing}       muted prefix="(−)" />
          <DreRow label="Aluguel"         value={-data.aluguel}         muted prefix="(−)" />
          <DreRow label="Salários"        value={-data.salarios}        muted prefix="(−)" />
          <DreRow label="Operacional"     value={-data.operacional}     muted prefix="(−)" />
          <DreRow label="Impostos"        value={-data.impostos}        muted prefix="(−)" />
          <DreRow label="Frete (custo)"   value={-data.frete}           muted prefix="(−)" />
          <DreRow label="Outras Despesas" value={-data.outras_despesas} muted prefix="(−)" />
          <ResultRow
            label="Resultado Operacional"
            value={data.resultado_operacional}
            margin={data.margem_operacional_pct}
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
          {data.outras_receitas > 0 && (
            <DreRow label="Outras Receitas" value={data.outras_receitas} prefix="(+)" />
          )}
          <ResultRow
            label="Lucro Líquido Gerencial"
            value={data.lucro_liquido_gerencial}
            margin={data.margem_liquida_pct}
          />
        </CardContent>
      </Card>

      {/* ── INFORMATIVO DE CAIXA (fora da DRE) ────────────────────────────── */}
      {data.saida_caixa_estoque > 0 && (
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
              {formatCurrency(data.saida_caixa_estoque)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
