export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { applyBulkWholesaleChanges, bulkProductsSchema } from '@/services/wholesale/bulkProducts'

// PATCH /api/produtos/bulk
// { product_ids: number[] (1..200), changes: { wholesale_enabled?: boolean, wholesale_price_percent?: number } }
//
// Gerente+ (mesmo nível das outras ações em lote do ERP, ex.: envio em massa
// à Nuvemshop). Tenant sempre da sessão — o payload nunca traz company_id.
export async function PATCH(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = bulkProductsSchema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const summary = [
      ...flat.formErrors,
      ...Object.entries(flat.fieldErrors).flatMap(([field, msgs]) => (msgs ?? []).map((m) => `${field}: ${m}`)),
    ].join(' | ') || 'Dados inválidos.'
    return NextResponse.json({ error: summary }, { status: 422 })
  }

  const result = await applyBulkWholesaleChanges(
    createAdminClient() as any,
    { companyId: user.company_id, userId: user.id, userRole: user.role },
    parsed.data,
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json(result)
}
