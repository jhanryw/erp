import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { returnSale } from '@/services/vendas.service'
import { validateAuthorizationToken } from '@/lib/auth/validateAuthorizationToken'
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
      return NextResponse.json({ error: 'Autorização de gerente necessária para registrar devolução.' }, { status: 403 })
    }
    const tokenResult = await validateAuthorizationToken({
      tokenId,
      action:      'return_sale',
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
    const result = await returnSale(saleId, user.id, user.company_id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'return', resource: 'sale', resourceId: saleId,
      after: { status: 'returned' },
      authorized_by: authorizedBy,
      reason,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    logError({
      route: 'POST /api/vendas/[id]/devolucao',
      err,
      context: { user_id: user.id, company_id: user.company_id, sale_id: saleId },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
