export const dynamic = 'force-dynamic'

/**
 * POST /api/fiscal/nfce/emitir-homologacao — Fase Fiscal 4F.
 *
 * Único input aceito: `sale_id` (mesma regra de segurança da rota de
 * NF-e: nunca aceita CNPJ/token/CFOP/CSC ou qualquer dado fiscal arbitrário
 * no corpo).
 *
 * Diferença central em relação à rota de NF-e: esta rota primeiro RESOLVE
 * o tipo de documento com `resolveFiscalDocumentType` (a partir de
 * `sales.sale_origin`/`shipments.delivery_mode`, buscados aqui, nunca
 * aceitos do cliente) e só chama `submitNfceHomologacao` quando o
 * resultado for EXPLICITAMENTE `'nfce'` — itens 2-5 do pedido:
 *   - resultado `'nfe'`  → 422 estruturado, nunca emite NFC-e por engano
 *     pra uma venda que deveria ser NF-e.
 *   - resultado `'blocked'` → 422 estruturado com o motivo
 *     (`describeFiscalDocumentTypeBlockReason`), nunca um erro genérico.
 *
 * `submitNfceHomologacao` já bloqueia produção internamente
 * (`nfce_environment !== 'homologacao'` → 403) e checa `nfce_enabled` —
 * esta rota não duplica essa lógica (mesmo padrão da rota de NF-e).
 *
 * Admin-only.
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { submitNfceHomologacao } from '@/services/fiscal/submitNfceHomologacao'
import { resolveFiscalDocumentType, describeFiscalDocumentTypeBlockReason } from '@/lib/fiscal/resolveFiscalDocumentType'

const bodySchema = z.object({
  sale_id: z.number().int().positive(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return err('JSON inválido.', 400)
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const saleId = parsed.data.sale_id
  const admin = createAdminClient()

  const [{ data: sale }, { data: shipment }] = await Promise.all([
    (admin as any).from('sales').select('id, sale_origin').eq('id', saleId).eq('company_id', user.company_id).maybeSingle(),
    (admin as any).from('shipments').select('delivery_mode').eq('order_id', saleId).maybeSingle(),
  ])

  if (!sale) return err('Venda não encontrada.', 404)

  const resolverInput = { deliveryMode: shipment?.delivery_mode ?? null, saleOrigin: sale.sale_origin ?? null }
  const resolvedType = resolveFiscalDocumentType(resolverInput)

  if (resolvedType === 'blocked') {
    return ok({
      resolved_document_type: 'blocked',
      reason: describeFiscalDocumentTypeBlockReason(resolverInput),
    }, 422)
  }

  if (resolvedType !== 'nfce') {
    return ok({
      resolved_document_type: resolvedType,
      reason: `Esta venda resolve para ${resolvedType === 'nfe' ? 'NF-e' : resolvedType} — emissão de NFC-e não é permitida por esta rota pra esta venda. Use a rota de NF-e.`,
    }, 422)
  }

  const result = await submitNfceHomologacao(saleId, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  return ok({ emission: result.data })
}
