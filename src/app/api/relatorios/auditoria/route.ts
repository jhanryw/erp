export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

// Ações auditáveis relevantes para o relatório anti-fraude
const AUDIT_ACTIONS = [
  'cancel',          // cancelamento de venda
  'return',          // devolução de venda
  'delete',          // exclusão de qualquer recurso
  'adjust',          // ajuste de estoque
  'close_cash',      // fechamento de caixa
  'open_cash',       // abertura de caixa
  'reopen_cash',     // reabertura de caixa (alto risco)
  'cancel_movement', // cancelamento de sangria/suprimento
  'update',          // alterações em registros
]

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const resource = searchParams.get('resource') ?? undefined
  const action   = searchParams.get('action')   ?? undefined
  const from     = searchParams.get('from')     ?? undefined
  const to       = searchParams.get('to')       ?? undefined
  const limit    = Math.min(Number(searchParams.get('limit') ?? '100'), 500)

  const admin = createAdminClient()
  let query = (admin as any)
    .from('audit_logs')
    .select('id, ts, user_id, user_role, action, resource, resource_id, before_data, after_data, detail, ip_address, request_id, users(name)')
    .in('action', action ? [action] : AUDIT_ACTIONS)
    .order('ts', { ascending: false })
    .limit(limit)

  if (resource) query = query.eq('resource', resource)
  if (from)     query = query.gte('ts', from)
  if (to)       query = query.lte('ts', to)

  const { data, error } = await query as { data: unknown[] | null; error: { message: string } | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ logs: data ?? [] })
}
