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
 * `submitNfceHomologacao` já valida ambiente internamente (aceita
 * 'homologacao'/'producao' conforme `company_fiscal_settings.
 * nfce_environment`) e checa `nfce_enabled` — esta rota não duplica essa
 * lógica (mesmo padrão da rota de NF-e).
 *
 * Qualquer usuário autenticado da empresa (decisão de produto: operação
 * fiscal de venda nunca foi pra ser admin-only) — isolamento garantido
 * pela query da venda abaixo, sempre escopada por `user.company_id` (da
 * sessão, nunca do corpo da requisição).
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
  const { user, response: unauth } = await requireRole('usuario')
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

  // `shipments.order_id = saleId` — CONTRA `sales.id` (mesmo `saleId`
  // validado acima), nunca `pedidos.id` (tabela não relacionada, PK UUID,
  // staging de webhook Nuvemshop). Mesmo join já usado por
  // `vw_sale_shipping_summary` (`20260613_shipping_fiscal_ready.sql:169`)
  // — não inventado aqui. Sem FK enforced entre as duas tabelas (auditado
  // na Fase Fiscal 4G, achado real na venda 636: `sale_origin='store'`,
  // sem nenhuma linha `shipments`, `shipping_charged=10`) — ausência de
  // linha vira `deliveryMode: null` abaixo, nunca inferido de
  // `shipping_charged` (nem buscado nesta rota — `shipping_charged` não
  // participa da decisão fiscal em nenhum ponto do projeto).
  // `resolveFiscalDocumentType` já trata `deliveryMode: null` +
  // `saleOrigin: 'store'` como retirada (`nfce`), sem depender da
  // existência de `shipments`.
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
