import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { returnSale } from '@/services/vendas.service'
import { validateAuthorizationToken } from '@/lib/auth/validateAuthorizationToken'
import { createAdminClient } from '@/lib/supabase/admin'
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
    // Fase Fiscal 6, seção 23 do pedido — mesma coordenação venda×fiscal
    // aplicada em /cancelar (ver comentário completo lá): uma devolução
    // total tem o MESMO risco de deixar o ERP divergente da SEFAZ se a
    // venda já tem um documento fiscal AUTORIZADO EM PRODUÇÃO. Cancelamento
    // fiscal automatizado ainda não existe neste ERP (gap documentado) —
    // bloqueio explícito é a correção de menor risco.
    //
    // `environment='producao'` explícito (fundação homologação↔produção,
    // 2026-09-06): homologação é só teste, sem valor fiscal — nunca deve
    // bloquear devolução de uma venda real.
    const admin = createAdminClient()
    const { data: authorizedDoc } = await (admin as any)
      .from('fiscal_documents')
      .select('id, document_type, number, series')
      .eq('sale_id', saleId)
      .eq('company_id', user.company_id)
      .eq('environment', 'producao')
      .eq('status', 'authorized')
      .maybeSingle()

    if (authorizedDoc) {
      const label = authorizedDoc.document_type === 'nfce' ? 'NFC-e' : 'NF-e'
      return NextResponse.json({
        error: `Esta venda tem uma ${label} autorizada${authorizedDoc.number ? ` (nº ${authorizedDoc.number}/${authorizedDoc.series})` : ''} — cancelamento fiscal ainda não é automatizado neste ERP. Cancele/inutilize o documento fiscal diretamente com o emissor antes de registrar a devolução.`,
      }, { status: 409 })
    }

    const result = await returnSale(saleId, user.id, user.company_id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'return', resource: 'sale', resourceId: saleId,
      after: { status: 'returned' },
      authorized_by:          authorizedBy,
      reason,
      authorization_token_id: typeof body.authorization_token_id === 'string' ? body.authorization_token_id : undefined,
      authorization_action:   authorizedBy ? 'return_sale' : undefined,
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
