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

    // Fase Fiscal 6, seção 23 do pedido — coordenação venda×fiscal. Este
    // ERP AINDA NÃO implementa cancelamento fiscal automatizado (nenhuma
    // rota/serviço chama `DELETE /v2/nfe|nfce/{ref}` da Focus — auditado
    // nesta fase, gap documentado no relatório). Sem essa peça, permitir
    // cancelar uma venda no ERP enquanto ela tem uma NF-e/NFC-e AUTORIZADA
    // EM PRODUÇÃO deixaria o sistema fiscal (SEFAZ) e o ERP divergentes —
    // a nota continuaria válida do lado de fora, sem nenhum registro aqui
    // de que a operação foi desfeita. Bloqueio explícito é a correção de
    // menor risco: nunca "apagar" o documento silenciosamente, nunca
    // fingir que cancelar a venda também cancela a nota. Documento em
    // qualquer OUTRO status (draft/pending/validation_failed/
    // authorization_failed/submission_error/cancelled/cancellation_failed)
    // nunca teve valor fiscal externo — não bloqueia.
    //
    // `environment='producao'` explícito (fundação homologação↔produção,
    // 2026-09-06): um documento AUTORIZADO EM HOMOLOGAÇÃO é só teste, sem
    // valor fiscal — nunca deveria impedir o cancelamento de uma venda
    // real. Sem esse filtro, uma NFC-e de homologação (o único ambiente
    // que existe hoje) bloquearia cancelamento como se fosse nota oficial.
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
        error: `Esta venda tem uma ${label} autorizada${authorizedDoc.number ? ` (nº ${authorizedDoc.number}/${authorizedDoc.series})` : ''} — cancelamento fiscal ainda não é automatizado neste ERP. Cancele/inutilize o documento fiscal diretamente com o emissor antes de cancelar a venda.`,
      }, { status: 409 })
    }

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
      authorized_by:          authorizedBy,
      reason,
      authorization_token_id: typeof body.authorization_token_id === 'string' ? body.authorization_token_id : undefined,
      authorization_action:   authorizedBy ? 'cancel_sale' : undefined,
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
