export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { financeEntrySchema } from '@/lib/validators'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = financeEntrySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  // cash_movement_id nunca é aceito aqui — só a futura RPC de regularização
  // (Entrega 3) ou a automação do Caixa (Entrega 4) preenchem esse campo.
  // paid_at é DATE: a string 'yyyy-MM-dd' do formulário vai direto ao banco,
  // sem nenhuma conversão de timezone.
  const admin = createAdminClient()
  const { error } = await admin.from('finance_entries').insert({
    ...parsed.data,
    paid_at: parsed.data.paid_at ?? null,
    created_by: user.id,
    company_id: user.company_id,
  } as any)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({ userId: user.id, userRole: user.role, action: 'create', resource: 'finance_entry', detail: `${parsed.data.type}:${parsed.data.category}:${parsed.data.amount}` })
  return NextResponse.json({ ok: true }, { status: 201 })
}
