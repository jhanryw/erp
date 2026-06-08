export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { closeCashSession } from '@/services/caixa.service'
import { auditLog } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// GET /api/caixa/fechar?session_id=X — prévia do expected_cash antes de fechar
export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const { searchParams } = new URL(request.url)
  const sessionId = parseInt(searchParams.get('session_id') ?? '')
  if (!sessionId || isNaN(sessionId)) {
    return NextResponse.json({ error: 'session_id inválido.' }, { status: 400 })
  }

  try {
    const admin = createAdminClient()

    // Fundo inicial da sessão
    const { data: sess } = await (admin as any)
      .from('cash_register_sessions')
      .select('opening_amount_cash, company_id')
      .eq('id', sessionId)
      .eq('status', 'open')
      .maybeSingle() as { data: { opening_amount_cash: number; company_id: number } | null }

    if (!sess) {
      return NextResponse.json({ error: 'Sessão não encontrada ou já fechada.' }, { status: 404 })
    }

    // Totais de pagamentos em dinheiro (bruto recebido, troco em dinheiro)
    const { data: pmtRows } = await (admin as any)
      .from('sale_payments')
      .select('amount_tendered, change_amount, change_method, method, net_amount')
      .in('sale_id',
        (admin as any)
          .from('sales')
          .select('id')
          .eq('cash_session_id', sessionId)
          .not('status', 'in', '("cancelled","returned")')
      ) as { data: Array<{
        amount_tendered: number
        change_amount: number
        change_method: string | null
        method: string
        net_amount: number
      }> | null }

    const rows = pmtRows ?? []
    const cashTendered  = rows
      .filter(r => r.method === 'cash')
      .reduce((s, r) => s + (r.amount_tendered ?? 0), 0)
    const cashChangeCash = rows
      .filter(r => r.method === 'cash' && r.change_method === 'cash')
      .reduce((s, r) => s + (r.change_amount ?? 0), 0)

    // Movimentos ativos (sangria, suprimento, despesa em dinheiro)
    const { data: movRows } = await (admin as any)
      .from('cash_movements')
      .select('type, method, amount')
      .eq('cash_session_id', sessionId)
      .is('cancelled_at', null) as { data: Array<{ type: string; method: string; amount: number }> | null }

    const movs = movRows ?? []
    const totalSangria    = movs.filter(m => m.type === 'sangria').reduce((s, m) => s + m.amount, 0)
    const totalSuprimento = movs.filter(m => m.type === 'suprimento').reduce((s, m) => s + m.amount, 0)
    const expenseCash     = movs.filter(m => m.type === 'expense' && m.method === 'cash').reduce((s, m) => s + m.amount, 0)

    const expectedCash = Math.round((
      sess.opening_amount_cash
      + cashTendered
      - cashChangeCash
      + totalSuprimento
      - totalSangria
      - expenseCash
    ) * 100) / 100

    return NextResponse.json({ expected_cash: expectedCash })
  } catch (err) {
    console.error('[GET /api/caixa/fechar]', err)
    return NextResponse.json({ error: 'Erro ao calcular prévia.' }, { status: 500 })
  }
}

const schema = z.object({
  session_id:   z.number().int().positive(),
  counted_cash: z.number().min(0),
  notes:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

// POST /api/caixa/fechar — restrito a gerente/admin
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await closeCashSession(parsed.data.session_id, user.id, parsed.data.counted_cash, parsed.data.notes)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'close_cash', resource: 'cash_session',
    resourceId: parsed.data.session_id,
    after: {
      counted_cash:    result.data.counted_cash,
      expected_cash:   result.data.expected_cash,
      cash_difference: result.data.cash_difference,
      total_sales:     result.data.total_sales,
    },
  })

  return NextResponse.json({ summary: result.data })
}
