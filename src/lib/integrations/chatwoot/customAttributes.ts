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
  { key: 'qarvon_categories', displayName: 'Qarvon — Categorias Compradas', type: 0 as const, description: 'Tipos de produto (product_types) em que o cliente já comprou de verdade, separados por vírgula. Ex.: "Calcinha, Pijama, Sutiã".' },
] as const

export type QarvonAttributeKey = (typeof QARVON_CUSTOM_ATTRIBUTES)[number]['key']

/**
 * Tipos de produto (`product_types`) reais e confirmados do catálogo da
 * Santtorini, usados só pra REGISTRAR a definição `qarvon_size_<slug>` no
 * Chatwoot (nunca pra calcular o valor em si — isso é
 * `computeCustomerPurchaseProfile`, que lê `product_types` do banco de
 * verdade a cada reconciliação). Lista confirmada contra
 * 202607301700_pim_seed_legacy_product_types.sql +
 * 202607302200_pim_seed_categorias_todos_tipos.sql — nunca inventada.
 *
 * Exclui deliberadamente: `sex_shop` (linha de produto distinta, tamanho
 * não é um conceito comercial relevante do mesmo jeito) e os 4 Tipos que a
 * própria migration do catálogo marca como "gap conhecido, sem lista real
 * confirmada" (`pijama_vestido`, `pijama_americano`, `camisola_americana`,
 * `pijama_rendado`) — nunca inventar categoria fictícia.
 *
 * Duplicação deliberada e aceita (mesmo princípio já usado em
 * QARVON_CUSTOM_ATTRIBUTES, replicado em scripts/*.mjs sem tsx/ts-node):
 * se o catálogo de Tipos mudar (novo Tipo criado em `/configuracoes`),
 * rode `ensureChatwootCustomAttributes` de novo (idempotente) depois de
 * atualizar esta lista. Um Tipo NÃO listado aqui ainda assim tem seu
 * `qarvon_size_<slug>` GRAVADO normalmente pela reconciliação — só fica
 * sem definição bonita no painel do Chatwoot até a lista ser atualizada
 * (degradação cosmética, nunca perda de dado).
 */
export const QARVON_SIZE_PRODUCT_TYPES = [
  { slug: 'sutia', name: 'Sutiã' },
  { slug: 'calcinha', name: 'Calcinha' },
  { slug: 'body', name: 'Body' },
  { slug: 'pijama', name: 'Pijama' },
  { slug: 'camisola', name: 'Camisola' },
  { slug: 'baby_doll', name: 'Baby Doll' },
  { slug: 'robe', name: 'Robe' },
  { slug: 'top', name: 'Top' },
  { slug: 'short_doll', name: 'Short Doll' },
  { slug: 'conjunto_calcinha_sutia', name: 'Conjunto Calcinha e Sutiã' },
  { slug: 'cinta', name: 'Cinta' },
  { slug: 'meia_calca', name: 'Meia-calça' },
  { slug: 'acessorio_intimo', name: 'Acessório Íntimo' },
] as const

export interface ChatwootAttributeDefinitionLike {
  key: string
  displayName: string
  type: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  description: string
}

/** Pura, exportada pra teste — gera 1 definição `qarvon_size_<slug>` por Tipo de QARVON_SIZE_PRODUCT_TYPES. */
export function buildQarvonSizeAttributeDefinitions(): ChatwootAttributeDefinitionLike[] {
  return QARVON_SIZE_PRODUCT_TYPES.map((t) => ({
    key: `qarvon_size_${t.slug}`,
    displayName: `Qarvon — Tamanho (${t.name})`,
    type: 0,
    description: `Tamanho mais comprado pelo cliente em ${t.name} (maior quantidade; empate resolvido pela compra mais recente).`,
  }))
}

export interface EnsureCustomAttributesResult {
  created: string[]
  alreadyExisted: string[]
}

/**
 * Idempotente: só cria as definições que ainda não existem. Chamada
 * administrativa (seção 40 do pedido da Fase 4 — parte de
 * `setupChatwootIntegration`, NUNCA dentro do fluxo de sincronização por
 * evento — decisão preservada nesta fase). Registra os atributos fixos
 * (QARVON_CUSTOM_ATTRIBUTES) + 1 `qarvon_size_<slug>` por Tipo real do
 * catálogo (QARVON_SIZE_PRODUCT_TYPES).
 */
export async function ensureChatwootCustomAttributes(
  config: ChatwootClientConfig,
): Promise<ServiceOutcome<EnsureCustomAttributesResult>> {
  const existingResult = await listChatwootCustomAttributeDefinitions(config)
  if (!existingResult.ok) return failure(existingResult.error.message)

  const existingKeys = new Set(existingResult.data.map((d) => d.attribute_key))
  const created: string[] = []
  const alreadyExisted: string[] = []

  const allAttributes: ChatwootAttributeDefinitionLike[] = [...QARVON_CUSTOM_ATTRIBUTES, ...buildQarvonSizeAttributeDefinitions()]

  for (const attr of allAttributes) {
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
