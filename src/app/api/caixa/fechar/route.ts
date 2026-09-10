export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { closeCashSession, type CloseSessionResult } from '@/services/caixa.service'
import { auditLog } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Conferência cega: mensagem única e neutra pra qualquer divergência —
// nunca varia com a distância do valor correto (não é oráculo de "perto"/
// "longe", só de "bateu"/"não bateu", que é inerente a qualquer conferência
// às cegas — ver auditoria, seção 15).
const BLIND_MISMATCH_MESSAGE = 'O valor informado não corresponde ao caixa. Faça uma nova contagem e tente novamente.'

// GET /api/caixa/fechar?session_id=X — prévia do expected_cash antes de fechar.
// Restrito a gerente/admin: essa prévia é uma ferramenta de conferência
// gerencial, não faz parte do fluxo do seller (que fecha às cegas, sem ver
// o valor esperado em momento algum — nem antes, nem depois de errar).
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

/**
 * Remove os campos sensíveis da conferência cega antes de a resposta sair
 * pro browser. Feito aqui (camada HTTP), não no service nem na RPC, porque
 * é aqui que o role do chamador (`user.role`) é conhecido — a RPC roda via
 * service_role e não tem esse contexto, e não deveria precisar dele: ela
 * sempre calcula e retorna tudo pra quem a chama (server-side, nunca
 * exposta ao browser), e esta função decide o que atravessa a fronteira
 * HTTP de acordo com quem está do outro lado.
 */
function summaryForRole(result: CloseSessionResult, role: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...result }
  if (role !== 'gerente' && role !== 'admin') {
    delete rest.expected_cash
    delete rest.cash_difference
  }
  return rest
}

// POST /api/caixa/fechar — seller (usuario) fecha o próprio caixa sem senha
// administrativa. A decisão de fechar ou não é tomada dentro da RPC
// (rpc_close_cash_session), nunca no frontend nem nesta rota — aqui só se
// filtra o que a resposta pode conter.
export async function POST(request: Request) {
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
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

  if (result.data.status === 'mismatch') {
    // Auditado sem nenhum valor sensível — só o fato de que uma tentativa
    // divergente ocorreu. A sessão continua aberta; nenhuma venda,
    // movimento ou dado contábil foi tocado.
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'close_cash_mismatch', resource: 'cash_session',
      resourceId: parsed.data.session_id,
      detail: 'Tentativa de fechamento com valor contado divergente — sessão permanece aberta.',
    })
    return NextResponse.json({ mismatch: true, message: BLIND_MISMATCH_MESSAGE })
  }

  const closed = result.data.result

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'close_cash', resource: 'cash_session',
    resourceId: parsed.data.session_id,
    after: {
      counted_cash:    closed.counted_cash,
      expected_cash:   closed.expected_cash,
      cash_difference: closed.cash_difference,
      total_sales:     closed.total_sales,
    },
  })

  return NextResponse.json({ summary: summaryForRole(closed, user.role) })
}
