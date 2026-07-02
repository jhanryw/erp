export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

// Estrutura retornada pela view vw_dre_mensal
type DreMensal = {
  mes: string
  company_id: number
  receita_bruta: number
  descontos: number
  receita_liquida: number
  cmv: number
  lucro_bruto: number
  margem_bruta_pct: number
  marketing: number
  aluguel: number
  salarios: number
  operacional: number
  impostos: number
  frete: number
  outras_despesas: number
  total_opex: number
  outras_receitas: number
  lucro_liquido_gerencial: number
  margem_liquida_pct: number
  saida_caixa_estoque: number
}

function zeroRow(mes: string, company_id: number): DreMensal {
  return {
    mes, company_id,
    receita_bruta: 0, descontos: 0, receita_liquida: 0,
    cmv: 0, lucro_bruto: 0, margem_bruta_pct: 0,
    marketing: 0, aluguel: 0, salarios: 0, operacional: 0,
    impostos: 0, frete: 0, outras_despesas: 0, total_opex: 0,
    outras_receitas: 0, lucro_liquido_gerencial: 0, margem_liquida_pct: 0,
    saida_caixa_estoque: 0,
  }
}

/**
 * GET /api/financeiro/dre?month=YYYY-MM
 *
 * Retorna DRE gerencial por competência para o mês informado.
 * CMV calculado a partir de sale_items.unit_cost × quantity.
 * stock_purchase aparece em `saida_caixa_estoque` — NÃO entra no lucro líquido.
 *
 * Requer role >= gerente.
 */
export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const monthParam = searchParams.get('month') // esperado: YYYY-MM

  // Resolve o primeiro dia do mês solicitado (ou mês atual)
  let mesIso: string
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    mesIso = `${monthParam}-01`
  } else {
    const now = new Date()
    mesIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }

  const admin = createAdminClient()

  const { data, error } = (await admin
    .from('vw_dre_mensal')
    .select('*')
    .eq('company_id', user.company_id)
    .eq('mes', mesIso)
    .maybeSingle()) as unknown as { data: DreMensal | null; error: { message: string } | null }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Mês sem movimento: retorna zeros para o frontend não precisar tratar null
  const dre = data ?? zeroRow(mesIso, user.company_id)

  return NextResponse.json({ dre })
}
