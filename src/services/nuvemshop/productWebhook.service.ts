/**
 * Processamento de webhooks de produto da Nuvemshop.
 *
 * product/deleted: invalida SOMENTE os vínculos que apontam para aquele
 * produto remoto, dentro da empresa dona da loja que enviou o evento. Não
 * toca produto/variação/estoque do ERP e não cria nada. Idempotente: evento
 * repetido encontra zero vínculos e não faz nada.
 */

import type { NuvemshopContext } from './context.service'
import {
  findNuvemshopMappingsByRemoteProduct,
  invalidateNuvemshopProductMapping,
  logNuvemshopEvent,
} from './mappings.service'
import type { ServiceOutcome } from '../produtos.service'

export const HANDLED_PRODUCT_EVENTS = new Set(['product/deleted'])

export async function processNuvemshopProductDeleted(
  ctx: NuvemshopContext,
  remoteProductId: string,
): Promise<ServiceOutcome<{ invalidated_products: number[]; removed_rows: number }>> {
  const mappings = await findNuvemshopMappingsByRemoteProduct(ctx.companyId, remoteProductId)
  if (!mappings.ok) return mappings

  const invalidated: number[] = []
  let removedRows = 0
  for (const m of mappings.data) {
    const res = await invalidateNuvemshopProductMapping(ctx.companyId, m.productId, {
      expectedRemoteProductId: remoteProductId,
      reason: 'webhook_product_deleted',
      metadata: { store_id: ctx.storeId },
    })
    if (!res.ok) return res
    if (res.data.removed > 0) { invalidated.push(m.productId); removedRows += res.data.removed }
  }

  await logNuvemshopEvent({
    eventType: 'webhook_product_deleted', direction: 'ns_to_erp', externalProductId: remoteProductId,
    metadata: { company_id: ctx.companyId, store_id: ctx.storeId, invalidated_products: invalidated, removed_rows: removedRows, duplicate: removedRows === 0 },
  })
  return { ok: true, data: { invalidated_products: invalidated, removed_rows: removedRows } }
}
