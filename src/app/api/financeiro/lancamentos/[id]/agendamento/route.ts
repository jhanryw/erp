export const dynamic = 'force-dynamic'

/**
 * POST /api/financeiro/lancamentos/[id]/agendamento
 *
 * Ações sobre pagamento AGENDADO de despesa (payment_status = 'scheduled'):
 *   { action: 'confirm',    paid_at?: 'yyyy-MM-dd' }  scheduled -> paid
 *   { action: 'cancel' }                              scheduled -> pending
 *   { action: 'reschedule', paid_at: 'yyyy-MM-dd' }   scheduled -> scheduled
 *
 * Concorrência: o UPDATE é condicionado a payment_status = 'scheduled' (e à
 * data programada lida, em reschedule/confirm), então duas operações
 * simultâneas não se sobrescrevem: a segunda recebe 409.
 * Nada aqui roda por data/cron — a confirmação é sempre explícita.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { brazilDate } from '@/lib/utils/date'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), paid_at: DATE.optional() }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('reschedule'), paid_at: DATE }).strict(),
])

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let raw: unknown
  try { raw = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Dados inválidos' }, { status: 422 })
  }
  const body = parsed.data
  const today = brazilDate()

  const admin = createAdminClient()
  const { data: before } = (await (admin as any)
    .from('finance_entries')
    .select('*')
    .eq('id', id)
    .eq('company_id', user.company_id)
    .maybeSingle()) as { data: any }
  if (!before) return NextResponse.json({ error: 'Registro não encontrado' }, { status: 404 })
  if (before.payment_status !== 'scheduled') {
    return NextResponse.json({ error: 'Este lançamento não está mais agendado (já foi efetivado, cancelado ou alterado). Recarregue a página.' }, { status: 409 })
  }

  let patch: Record<string, unknown>
  if (body.action === 'confirm') {
    const paidAt = body.paid_at ?? today
    if (paidAt > today) {
      return NextResponse.json({ error: 'Data de pagamento não pode ser no futuro.' }, { status: 422 })
    }
    patch = { payment_status: 'paid', paid_at: paidAt }
  } else if (body.action === 'cancel') {
    patch = { payment_status: 'pending', paid_at: null, payment_method: null }
  } else {
    if (body.paid_at < today) {
      return NextResponse.json({ error: 'A nova data programada não pode estar no passado.' }, { status: 422 })
    }
    patch = { paid_at: body.paid_at }
  }

  const { error, count } = (await (admin as any)
    .from('finance_entries')
    .update(patch, { count: 'exact' })
    .eq('id', id)
    .eq('company_id', user.company_id)
    .eq('payment_status', 'scheduled')
    .eq('paid_at', before.paid_at)) as { error: any; count: number | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) {
    return NextResponse.json({ error: 'O lançamento foi alterado por outra operação. Recarregue a página.' }, { status: 409 })
  }

  auditLog({
    userId: user.id,
    userRole: user.role,
    action: 'update',
    resource: 'finance_entry',
    resourceId: id,
    before: { payment_status: before.payment_status, paid_at: before.paid_at, payment_method: before.payment_method },
    after: patch,
    detail: `agendamento:${body.action}`,
  })
  return NextResponse.json({ ok: true })
}
