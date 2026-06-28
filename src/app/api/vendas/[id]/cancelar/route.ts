import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { cancelSale } from '@/services/vendas.service'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateAuthorizationToken } from '@/lib/auth/validateAuthorizationToken'
import { pushMultipleVariantStocksToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const saleId = Number(params.id)

  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch { /* body opcional */ }

  let authorizedBy: string | undefined
  let reason: string | undefined

  if (user.role === 'usuario') {
    const tokenId = typeof body.authorization_token_id === 'string' ? body.authorization_token_id : undefined
    if (!tokenId) {
      return NextResponse.json({ error: 'Autorização de gerente necessária para cancelar venda.' }, { status: 403 })
    }
    const tokenResult = await validateAuthorizationToken({
      tokenId,
      action:      'cancel_sale',
      requestedBy: user.id,
      companyId:   user.company_id,
    })
    if (!tokenResult.ok) {
      return NextResponse.json({ error: tokenResult.error }, { status: 403 })
    }
    authorizedBy = tokenResult.authorizedBy
    reason       = tokenResult.reason ?? (typeof body.reason === 'string' ? body.reason : undefined)
  }

  try {
    const admin = createAdminClient()
    const { data: items } = await admin
      .from('sale_items')
      .select('product_variation_id')
      .eq('sale_id', saleId) as { data: Array<{ product_variation_id: number }> | null }

    const result = await cancelSale(saleId, user.id, user.company_id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'cancel', resource: 'sale', resourceId: saleId,
      after: { status: 'cancelled' },
      authorized_by: authorizedBy,
      reason,
    })

    const variationIds = [...new Set((items ?? []).map((i) => i.product_variation_id).filter(Boolean))]
    if (variationIds.length > 0) {
      pushMultipleVariantStocksToNuvemshop(variationIds, { eventType: 'stock_push_erp' }).catch((err) =>
        console.error('[cancelar/route] Falha ao sincronizar estoque na Nuvemshop após cancelamento', { saleId, err })
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    logError({
      route: 'POST /api/vendas/[id]/cancelar',
      err,
      context: { user_id: user.id, company_id: user.company_id, sale_id: saleId },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
