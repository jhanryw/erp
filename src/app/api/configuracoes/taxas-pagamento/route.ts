import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'

export const dynamic = 'force-dynamic'

// ─── GET — lista todas as taxas da empresa ────────────────────────────────────

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Empresa não configurada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('payment_fee_settings')
    .select('id, payment_method, installments, label, fee_percentage')
    .eq('company_id', user.company_id)
    .order('payment_method')
    .order('installments')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ fees: data ?? [] })
}

// ─── PUT — salva todas as taxas (bulk upsert) ─────────────────────────────────

const rowSchema = z.object({
  id:             z.number().int().positive(),
  fee_percentage: z.number().min(0).max(100),
})

const putSchema = z.object({
  fees: z.array(rowSchema).min(1),
})

export async function PUT(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Empresa não configurada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()

  // Verificar que todos os IDs pertencem à empresa antes de atualizar
  const ids = parsed.data.fees.map(f => f.id)
  const { data: owned } = await admin
    .from('payment_fee_settings')
    .select('id')
    .eq('company_id', user.company_id)
    .in('id', ids)

  const ownedIds = new Set((owned ?? []).map((r: { id: number }) => r.id))
  const unauthorized = ids.filter(id => !ownedIds.has(id))
  if (unauthorized.length > 0) {
    return NextResponse.json({ error: 'Acesso negado a alguns registros.' }, { status: 403 })
  }

  // Atualizar cada taxa individualmente
  const now = new Date().toISOString()
  const updates = parsed.data.fees.map(fee =>
    admin
      .from('payment_fee_settings')
      .update({ fee_percentage: fee.fee_percentage, updated_at: now })
      .eq('id', fee.id)
      .eq('company_id', user.company_id)
  )

  const results = await Promise.all(updates)
  const failed = results.filter(r => r.error)
  if (failed.length > 0) {
    return NextResponse.json({ error: 'Erro ao salvar algumas taxas.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
