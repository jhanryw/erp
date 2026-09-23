export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { addKitVariations } from '@/services/kits.service'
import { addKitVariationsSchema, zodErrorMessage } from '../../schema'

/** POST /api/produtos/kits/[id]/variacoes — adiciona variações vendáveis (com composição) a um kit. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const productId = Number(params.id)
  if (!Number.isInteger(productId) || productId <= 0) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = addKitVariationsSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })

  const result = await addKitVariations(user.id, productId, parsed.data.variations)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'product', resourceId: productId,
    detail: `kit: variações adicionadas ${result.data.variations.map((v) => v.sku_variation).join(', ')}`,
  })

  return NextResponse.json(result.data, { status: 201 })
}
