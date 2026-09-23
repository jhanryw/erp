export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { setKitComponents } from '@/services/kits.service'
import { findKitVariationIds, getKitCompositionDetails } from '@/services/inventory/availability.service'
import { setKitComponentsSchema, zodErrorMessage } from '../../../schema'

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** GET — composição da variação de kit com estoque/capacidade por componente e disponibilidade derivada. */
export async function GET(_request: Request, { params }: { params: { variationId: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const variationId = parseId(params.variationId)
  if (!variationId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const kits = await findKitVariationIds(user.company_id, [variationId])
  if (!kits.ok) return NextResponse.json({ error: kits.error }, { status: kits.status })
  if (!kits.data.has(variationId)) return NextResponse.json({ error: 'Kit não encontrado.' }, { status: 404 })

  const details = await getKitCompositionDetails(user.company_id, [variationId])
  if (!details.ok) return NextResponse.json({ error: details.error }, { status: details.status })

  return NextResponse.json({ composition: details.data.get(variationId) ?? null })
}

/** PUT — substitui a composição inteira (vendas antigas não mudam: usam o snapshot). */
export async function PUT(request: Request, { params }: { params: { variationId: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const variationId = parseId(params.variationId)
  if (!variationId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = setKitComponentsSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })

  const result = await setKitComponents(user.id, variationId, parsed.data.components)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'product', resourceId: variationId,
    detail: `kit: composição ${result.data.map((c) => `${c.quantity}x#${c.component_product_variation_id}`).join(' + ')}`,
  })

  const details = await getKitCompositionDetails(user.company_id, [variationId])
  return NextResponse.json({ composition: details.ok ? details.data.get(variationId) ?? null : null })
}
