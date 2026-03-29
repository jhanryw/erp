export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { createSupplier } from '@/services/fornecedores.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name:     z.string().min(2),
  document: z.preprocess(n, z.string().nullable().optional()),
  phone:    z.preprocess(n, z.string().nullable().optional()),
  city:     z.preprocess(n, z.string().nullable().optional()),
  state:    z.preprocess(n, z.string().length(2).nullable().optional()),
  notes:    z.preprocess(n, z.string().nullable().optional()),
  active:   z.boolean().default(true),
})

// ─── GET /api/fornecedores ────────────────────────────────────────────────────

export async function GET() {
  // Lista pública no escopo do dashboard — autenticação garantida pelo middleware
  const admin = createAdminClient() // admin client: contorna RLS (tabela sem policy pública)
  const { data, error } = await admin
    .from('suppliers')
    .select('id, name')
    .eq('active', true)
    .order('name') as unknown as { data: { id: number; name: string }[] | null; error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ suppliers: data ?? [] })
}

// ─── POST /api/fornecedores ───────────────────────────────────────────────────

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await createSupplier(parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'supplier',
    resourceId: result.data.id, detail: parsed.data.name,
  })
  return NextResponse.json({ supplier: result.data }, { status: 201 })
}
