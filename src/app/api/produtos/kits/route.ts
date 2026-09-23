export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { createKitProduct } from '@/services/kits.service'
import { createKitSchema, zodErrorMessage } from './schema'

/**
 * POST /api/produtos/kits — cria um produto KIT (produto do catálogo com
 * product_kind='kit') com variações vendáveis e composição, numa única
 * transação (rpc_create_kit_product). Mesmo nível de acesso da criação de
 * produto normal (POST /api/produtos).
 */
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = createKitSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })

  const result = await createKitProduct(user.id, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'product', resourceId: result.data.product_id,
    detail: `kit ${parsed.data.sku}: ${result.data.variations.map((v) => v.sku_variation).join(', ')}`,
  })

  return NextResponse.json({ product: { id: result.data.product_id }, variations: result.data.variations }, { status: 201 })
}
