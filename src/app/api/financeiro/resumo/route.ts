export const dynamic = 'force-dynamic'

/**
 * GET /api/financeiro/resumo
 *
 * Retorna P&L (demonstrativo de resultado) por período.
 * Agrega finance_entries por tipo e categoria filtrando por company_id.
 * Requer role mínimo: gerente.
 *
 * Query params:
 *   from  — data inicial (YYYY-MM-DD, default: primeiro dia do mês atual)
 *   to    — data final   (YYYY-MM-DD, default: hoje)
 *
 * Resposta:
 *   revenue          — receita bruta (income: sale)
 *   cashback_used    — cashback descontado das vendas (income: cashback_used)
 *   other_income     — outras receitas
 *   gross_revenue    — revenue + cashback_used + other_income
 *   cost_of_goods    — CMV (expense: stock_purchase)
 *   gross_profit     — gross_revenue - cost_of_goods
 *   marketing        — despesas de marketing
 *   freight          — frete cobrado como custo
 *   operational      — aluguel, salários, operacional
 *   taxes            — impostos
 *   other_expense    — outras despesas
 *   total_expenses   — soma de todas as despesas
 *   net_result       — gross_revenue - total_expenses
 *   breakdown        — linhas agregadas por (type, category)
 */

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)

  // Default: mês atual no fuso Brasil
  const defaultTo   = brazilDate()
  const defaultFrom = defaultTo.slice(0, 7) + '-01'

  const from = searchParams.get('from') || defaultFrom
  const to   = searchParams.get('to')   || defaultTo

  const admin = createAdminClient()

  const { data: entries, error } = await admin
    .from('finance_entries')
    .select('type, category, amount')
    .eq('company_id', user.company_id)
    .gte('reference_date', from)
    .lte('reference_date', to) as unknown as {
      data: { type: 'income' | 'expense'; category: string; amount: number }[] | null
      error: { message: string } | null
    }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── Agregar por (type, category) ─────────────────────────────────────────────

  const breakdown: Record<string, number> = {}
  for (const e of entries ?? []) {
    const key = `${e.type}:${e.category}`
    breakdown[key] = (breakdown[key] ?? 0) + e.amount
  }

  const get = (key: string) => breakdown[key] ?? 0

  const revenue       = get('income:sale')
  const cashback_used = get('income:cashback_used')
  const other_income  = get('income:other_income')
  const gross_revenue = revenue + cashback_used + other_income

  const cost_of_goods = get('expense:stock_purchase')
  const gross_profit  = gross_revenue - cost_of_goods

  const marketing     = get('expense:marketing')
  const freight       = get('expense:freight_cost')
  const rent          = get('expense:rent')
  const salaries      = get('expense:salaries')
  const operational   = get('expense:operational') + rent + salaries
  const taxes         = get('expense:taxes')
  const other_expense = get('expense:other_expense')

  const total_expenses = cost_of_goods + marketing + freight + operational + taxes + other_expense
  const net_result     = gross_revenue - total_expenses

  // Breakdown formatado como array para o frontend
  const breakdownArray = Object.entries(breakdown).map(([key, amount]) => {
    const [type, category] = key.split(':')
    return { type, category, amount }
  })

  return NextResponse.json({
    period: { from, to },
    revenue,
    cashback_used,
    other_income,
    gross_revenue,
    cost_of_goods,
    gross_profit,
    marketing,
    freight,
    operational,
    taxes,
    other_expense,
    total_expenses,
    net_result,
    breakdown: breakdownArray,
  })
}
