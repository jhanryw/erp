/**
 * Catálogo de custom attributes `qarvon_*` sincronizados no contato do
 * Chatwoot (Fase 4) + operação idempotente pra garantir que as definições
 * existem antes de qualquer atualização de contato.
 *
 * Namespace `qarvon_*` (seção 13 do pedido) — evita colisão com atributos
 * de outros sistemas/agentes que a empresa já possa ter configurado no
 * Chatwoot.
 */

import {
  createChatwootCustomAttributeDefinition,
  listChatwootCustomAttributeDefinitions,
  type ChatwootClientConfig,
} from './client'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export const QARVON_CUSTOM_ATTRIBUTES = [
  { key: 'qarvon_customer_id', displayName: 'Qarvon — ID do Cliente', type: 0 as const, description: 'ID do cliente no ERP Qarvon (customers.id).' },
  { key: 'qarvon_total_orders', displayName: 'Qarvon — Total de Pedidos', type: 1 as const, description: 'Quantidade de pedidos válidos (exclui cancelados/devolvidos).' },
  { key: 'qarvon_total_spent', displayName: 'Qarvon — Total Gasto', type: 2 as const, description: 'Soma do valor de pedidos válidos, em BRL.' },
  { key: 'qarvon_average_ticket', displayName: 'Qarvon — Ticket Médio', type: 2 as const, description: 'total_spent / total_orders, em BRL.' },
  { key: 'qarvon_first_purchase_at', displayName: 'Qarvon — Primeira Compra', type: 5 as const, description: 'Data da primeira venda válida.' },
  { key: 'qarvon_last_purchase_at', displayName: 'Qarvon — Última Compra', type: 5 as const, description: 'Data da venda válida mais recente.' },
  { key: 'qarvon_customer_segment', displayName: 'Qarvon — Segmento (RFM)', type: 0 as const, description: 'Segmento RFM calculado (mv_customer_rfm) — pode ficar até 1 refresh desatualizado.' },
  { key: 'qarvon_cashback_available', displayName: 'Qarvon — Cashback Disponível', type: 2 as const, description: 'Saldo de cashback disponível pra uso (v_cashback_balance.available_balance), em BRL.' },
  { key: 'qarvon_erp_link', displayName: 'Qarvon — Ver no ERP', type: 4 as const, description: 'Link direto pro histórico completo de compras do cliente no Qarvon — fonte de verdade, nunca duplicada aqui (Fase MVP Chatwoot, seção 7 do pedido).' },
] as const

export type QarvonAttributeKey = (typeof QARVON_CUSTOM_ATTRIBUTES)[number]['key']

export interface EnsureCustomAttributesResult {
  created: string[]
  alreadyExisted: string[]
}

/**
 * Idempotente: só cria as definições que ainda não existem. Chamada
 * administrativa (seção 40 do pedido — parte de `setupChatwootIntegration`,
 * nunca dentro do fluxo de sincronização por evento).
 */
export async function ensureChatwootCustomAttributes(
  config: ChatwootClientConfig,
): Promise<ServiceOutcome<EnsureCustomAttributesResult>> {
  const existingResult = await listChatwootCustomAttributeDefinitions(config)
  if (!existingResult.ok) return failure(existingResult.error.message)

  const existingKeys = new Set(existingResult.data.map((d) => d.attribute_key))
  const created: string[] = []
  const alreadyExisted: string[] = []

  for (const attr of QARVON_CUSTOM_ATTRIBUTES) {
    if (existingKeys.has(attr.key)) {
      alreadyExisted.push(attr.key)
      continue
    }
    const createResult = await createChatwootCustomAttributeDefinition(config, {
      attributeKey: attr.key,
      attributeDisplayName: attr.displayName,
      attributeDisplayType: attr.type,
      attributeDescription: attr.description,
    })
    if (!createResult.ok) return failure(`Falha ao criar atributo ${attr.key}: ${createResult.error.message}`)
    created.push(attr.key)
  }

  return success({ created, alreadyExisted })
}
