/**
 * Reconciliação de atributos comerciais: customer (ERP) → contato Chatwoot
 * (Fase 4). Regra inegociável (seção 8 do pedido): Qarvon é a verdade
 * comercial, Chatwoot é só uma PROJEÇÃO — nunca o inverso.
 *
 * Caminho canônico de resolução (seção 16):
 *   customer → crm_person_customer_links → crm_person → external_entity_links → contact_id
 * Nunca busca contato por telefone a cada sync — sempre via o vínculo já
 * existente (Fases 1-3).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { listPersonCustomerLinksByCustomer } from '@/services/crm/person-customer-links.service'
import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import { findLinkForEntity, updateExternalEntityLinkMetadata } from '@/services/integrations/external-entity-links.service'
import {
  getChatwootContact,
  updateChatwootContactCustomAttributes,
  isPermanentChatwootError,
  type ChatwootClientConfig,
} from './client'
import { QARVON_CUSTOM_ATTRIBUTES } from './customAttributes'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── 1. Resolução customer → crm_person (seção 18) ─────────────────────────

export type PersonForCustomerResult =
  | { status: 'resolved'; personId: number }
  | { status: 'ambiguous' }
  | { status: 'no_person' }

/**
 * `is_primary` é uma coluna do VÍNCULO (crm_person_customer_links), não da
 * pessoa nem do customer — nada impede, estruturalmente, que duas pessoas
 * DIFERENTES tenham cada uma seu próprio vínculo `is_primary=true` pro
 * MESMO customer (o índice único parcial só garante 1 primary por PESSOA,
 * não por customer). Por isso: só resolve sem ambiguidade quando há
 * exatamente 1 vínculo ativo, OU quando há mais de 1 mas exatamente 1
 * deles está marcado `is_primary=true`.
 */
export async function resolvePersonForCustomer(
  customerId: number,
  companyId: number,
): Promise<ServiceOutcome<PersonForCustomerResult>> {
  const linksResult = await listPersonCustomerLinksByCustomer(customerId, companyId)
  if (!linksResult.ok) return failure(linksResult.error, linksResult.status)

  const links = linksResult.data
  if (links.length === 0) return success({ status: 'no_person' })
  if (links.length === 1) return success({ status: 'resolved', personId: links[0].person_id })

  const primaries = links.filter((l) => l.is_primary)
  if (primaries.length === 1) return success({ status: 'resolved', personId: primaries[0].person_id })

  return success({ status: 'ambiguous' })
}

// ─── 2. Atributos comerciais — SEMPRE ao vivo contra `sales`, nunca da MV ──
//
// mv_customer_rfm é materializada (refresh assíncrono/periódico) — usá-la
// aqui arriscaria enviar números DESATUALIZADOS bem no momento em que a
// reconciliação foi disparada exatamente por uma venda ter mudado esses
// números (sale.completed → reconcilia). Só `customer_segment` vem da MV
// (não dá pra recalcular o ranking RFM completo, que depende de todos os
// clientes, a cada reconciliação individual) — aceito como podendo ficar
// até 1 refresh desatualizado, documentado no relatório da Fase 4.

export interface CustomerCommercialAttributes {
  totalOrders: number
  totalSpent: number
  averageTicket: number | null
  firstPurchaseAt: string | null // YYYY-MM-DD
  lastPurchaseAt: string | null // YYYY-MM-DD
  customerSegment: string | null
  /** Saldo disponível pra uso — sempre 0 (nunca null), mesma view já usada por GET /api/cashback/balance (v_cashback_balance.available_balance). Fase MVP Chatwoot, seção 6 do pedido. */
  cashbackAvailable: number
}

export async function computeCustomerCommercialAttributes(
  customerId: number,
  companyId: number,
): Promise<ServiceOutcome<CustomerCommercialAttributes>> {
  const admin = createAdminClient()

  const { data: sales, error: salesError } = await (admin as any)
    .from('sales')
    .select('total, sale_date, status')
    .eq('customer_id', customerId)
    .eq('company_id', companyId) as { data: { total: number; sale_date: string; status: string }[] | null; error: { message: string } | null }

  if (salesError) return failure(salesError.message)

  const valid = (sales ?? []).filter((s) => s.status !== 'cancelled' && s.status !== 'returned')
  const totalOrders = valid.length
  const totalSpent = valid.reduce((sum, s) => sum + Number(s.total), 0)
  const averageTicket = totalOrders > 0 ? Math.round((totalSpent / totalOrders) * 100) / 100 : null
  const dates = valid.map((s) => s.sale_date).sort()
  const firstPurchaseAt = dates[0] ?? null
  const lastPurchaseAt = dates[dates.length - 1] ?? null

  const { data: rfm } = await (admin as any)
    .from('mv_customer_rfm')
    .select('segment')
    .eq('customer_id', customerId)
    .maybeSingle() as { data: { segment: string } | null }

  const { data: cashback } = await (admin as any)
    .from('v_cashback_balance')
    .select('available_balance')
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { available_balance: number } | null }

  return success({
    totalOrders,
    totalSpent: Math.round(totalSpent * 100) / 100,
    averageTicket,
    firstPurchaseAt,
    lastPurchaseAt,
    customerSegment: rfm?.segment ?? null,
    cashbackAvailable: Math.round(Number(cashback?.available_balance ?? 0) * 100) / 100,
  })
}

// ─── 2b. Categorias compradas + tamanho preferencial (Fase "Enriquecimento
// comercial") — via rpc_customer_purchase_profile, ver migration
// 20260817_rpc_customer_purchase_profile.sql pro achado completo de
// modelagem (Tipo ≠ tabela `categories`; tamanho vem de
// product_variation_attributes, nunca de product_variations.size/.color,
// colunas mortas confirmadas 100% NULL em produção).

export interface CustomerPurchaseProfileEntry {
  productTypeSlug: string
  productTypeName: string
  totalQuantity: number
  /** null quando não há evidência suficiente (nenhuma variação com tamanho identificado nesse Tipo) — nunca inventado. */
  dominantSize: string | null
}

export interface CustomerPurchaseProfile {
  /** Nomes de product_types (Tipo) com pelo menos 1 compra válida — deduplicados, ordenados alfabeticamente (pt-BR). */
  categories: string[]
  sizesByType: CustomerPurchaseProfileEntry[]
}

interface CustomerPurchaseProfileRow {
  product_type_slug: string
  product_type_name: string
  total_quantity: number
  dominant_size: string | null
}

export async function computeCustomerPurchaseProfile(
  customerId: number,
  companyId: number,
): Promise<ServiceOutcome<CustomerPurchaseProfile>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any).rpc('rpc_customer_purchase_profile', {
    p_customer_id: customerId,
    p_company_id: companyId,
  }) as { data: CustomerPurchaseProfileRow[] | null; error: { message: string } | null }

  if (error) return failure(error.message)

  const rows = data ?? []
  const categories = Array.from(new Set(rows.map((r) => r.product_type_name))).sort((a, b) => a.localeCompare(b, 'pt-BR'))

  return success({
    categories,
    sizesByType: rows.map((r) => ({
      productTypeSlug: r.product_type_slug,
      productTypeName: r.product_type_name,
      totalQuantity: Number(r.total_quantity),
      dominantSize: r.dominant_size,
    })),
  })
}

/**
 * Pura, exportada pra teste — nunca inclui chave com valor ausente.
 * `qarvon_categories`: nomes de Tipo (product_types), deduplicados,
 * ordenados alfabeticamente, unidos por ", " (ex.: "Calcinha, Pijama,
 * Sutiã") — NUNCA a tabela `categories` (sub-classificação de estilo
 * dentro de um Tipo, ex.: "Rendada"/"Básico" — achado da auditoria,
 * ver migration da RPC). Omitido se o customer não tem nenhuma compra
 * válida classificável.
 *
 * `qarvon_size_<slug>`: um por Tipo, só quando há tamanho dominante
 * identificável (nunca inferido sem evidência — nunca envia chave pra
 * um Tipo sem nenhuma variação com tamanho cadastrado).
 */
export function buildQarvonCategoryAttributesPayload(profile: CustomerPurchaseProfile): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  if (profile.categories.length > 0) {
    payload.qarvon_categories = profile.categories.join(', ')
  }

  for (const entry of profile.sizesByType) {
    if (entry.dominantSize) {
      payload[`qarvon_size_${entry.productTypeSlug}`] = entry.dominantSize
    }
  }

  return payload
}

/**
 * Pura, exportada pra teste — nunca inclui chave com valor ausente (nunca
 * envia `null`/`undefined` ao Chatwoot).
 *
 * `qarvon_erp_link` (Fase MVP Chatwoot, seção 7 do pedido): link direto pra
 * `/clientes/:id` no ERP — decisão deliberada de NÃO despejar histórico de
 * compras aqui (custom attribute não é lugar pra lista, ver relatório da
 * fase, seção sobre histórico de compras). Só incluído quando
 * `NEXT_PUBLIC_APP_URL` está configurada (nunca um link relativo/quebrado).
 */
export function buildQarvonCustomAttributesPayload(customerId: number, attrs: CustomerCommercialAttributes): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    qarvon_customer_id: String(customerId),
    qarvon_total_orders: attrs.totalOrders,
    qarvon_total_spent: attrs.totalSpent,
    qarvon_cashback_available: attrs.cashbackAvailable,
  }
  if (attrs.averageTicket !== null) payload.qarvon_average_ticket = attrs.averageTicket
  if (attrs.firstPurchaseAt) payload.qarvon_first_purchase_at = attrs.firstPurchaseAt
  if (attrs.lastPurchaseAt) payload.qarvon_last_purchase_at = attrs.lastPurchaseAt
  if (attrs.customerSegment) payload.qarvon_customer_segment = attrs.customerSegment

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) payload.qarvon_erp_link = `${appUrl.replace(/\/$/, '')}/clientes/${customerId}`

  return payload
}

/**
 * Pura, exportada pra teste (seção 47 do pedido — nunca sobrescrever
 * atributo que não seja `qarvon_*`). `qarvonAttributes` sempre vence em
 * caso de colisão de chave (nunca deveria colidir na prática, já que o
 * namespace é exclusivo, mas a ordem de spread documenta a intenção).
 */
export function mergeChatwootCustomAttributes(
  current: Record<string, unknown>,
  qarvonAttributes: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...qarvonAttributes }
}

// ─── 3. Reconciliação completa ─────────────────────────────────────────────

export type ReconciliationOutcome =
  | { status: 'synced'; contactId: string }
  | { status: 'not_linked' }
  | { status: 'ambiguous_person' }
  | { status: 'no_person' }
  | { status: 'anonymous_customer' }
  | { status: 'integration_not_active' }
  | { status: 'permanent_error'; message: string }
  /**
   * Falha classificada como retryable pela própria resposta do Chatwoot
   * (429/5xx/timeout/network — `isPermanentChatwootError` retornou false).
   * Distinto do `failure()` genérico do ServiceOutcome (reservado pra erros
   * de infraestrutura nossa, ex.: Postgres fora do ar) — só assim
   * `retryAfterSeconds` (seção 13 do pedido da Fase 5, honrar `Retry-After`
   * de um 429) sobrevive até quem consome este resultado
   * (`deliveryConsumer.ts`) poder repassar pro backoff.
   */
  | { status: 'retryable_error'; message: string; retryAfterSeconds?: number }

/**
 * Fluxo completo (seção 35 do pedido). Nunca cria contato no Chatwoot
 * automaticamente (seção 17) — se não houver vínculo, retorna `not_linked`
 * e para. Nunca envia `name`/`phone_number`/`email`/`avatar`/`identifier`
 * (seção 22) — só `custom_attributes`, e só o namespace `qarvon_*`, mescladas
 * com o que já existia no contato (nunca sobrescreve atributo de outro
 * sistema).
 */
export async function reconcileCustomerToChatwoot(
  companyId: number,
  customerId: number,
): Promise<ServiceOutcome<ReconciliationOutcome>> {
  const admin = createAdminClient()

  const { data: customer, error: customerError } = await (admin as any)
    .from('customers')
    .select('id, is_anonymous')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: number; is_anonymous: boolean } | null; error: { message: string } | null }

  if (customerError) return failure(customerError.message)
  if (!customer) return failure('Cliente não encontrado.', 404)
  if (customer.is_anonymous) return success({ status: 'anonymous_customer' })

  const integrationResult = await getCompanyIntegration(companyId, 'chatwoot')
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  const integration = integrationResult.data
  if (!integration || integration.status !== 'active') return success({ status: 'integration_not_active' })

  const personResult = await resolvePersonForCustomer(customerId, companyId)
  if (!personResult.ok) return failure(personResult.error, personResult.status)
  if (personResult.data.status === 'no_person') return success({ status: 'no_person' })
  if (personResult.data.status === 'ambiguous') return success({ status: 'ambiguous_person' })

  const personId = personResult.data.personId

  // Defesa em profundidade (seção 20): confirma que o vínculo externo é
  // desta MESMA integração — nunca um contact de uma integração diferente.
  const linkResult = await findLinkForEntity(integration.id, 'crm_person', personId, 'contact')
  if (!linkResult.ok) return failure(linkResult.error, linkResult.status)
  if (!linkResult.data) return success({ status: 'not_linked' })

  const link = linkResult.data
  const contactId = link.external_id

  const apiTokenResult = await getIntegrationSecret(integration.id, companyId, 'api_token')
  if (!apiTokenResult.ok) return failure(apiTokenResult.error, apiTokenResult.status)
  if (!apiTokenResult.data) return success({ status: 'permanent_error', message: 'api_token não configurado para esta integração.' })

  const baseUrl = typeof integration.settings.base_url === 'string' ? integration.settings.base_url : null
  if (!baseUrl) return success({ status: 'permanent_error', message: 'settings.base_url não configurado para esta integração.' })

  const clientConfig: ChatwootClientConfig = { baseUrl, accountId: integration.external_account_id ?? '', apiToken: apiTokenResult.data }

  const attrsResult = await computeCustomerCommercialAttributes(customerId, companyId)
  if (!attrsResult.ok) return failure(attrsResult.error, attrsResult.status)

  const profileResult = await computeCustomerPurchaseProfile(customerId, companyId)
  if (!profileResult.ok) return failure(profileResult.error, profileResult.status)

  const qarvonAttributes = {
    ...buildQarvonCustomAttributesPayload(customerId, attrsResult.data),
    ...buildQarvonCategoryAttributesPayload(profileResult.data),
  }

  // Busca o contato atual pra mesclar (nunca substitui custom_attributes
  // de outro sistema — ver nota de incerteza em client.ts).
  const currentContactResult = await getChatwootContact(clientConfig, contactId)
  if (!currentContactResult.ok) {
    await updateExternalEntityLinkMetadata(link.id, companyId, { last_sync_error: currentContactResult.error.message, last_sync_at: new Date().toISOString() })
    if (isPermanentChatwootError(currentContactResult.error)) {
      return success({ status: 'permanent_error', message: currentContactResult.error.message })
    }
    return success({ status: 'retryable_error', message: currentContactResult.error.message, retryAfterSeconds: currentContactResult.error.retryAfterSeconds })
  }

  const mergedAttributes = mergeChatwootCustomAttributes(currentContactResult.data.custom_attributes ?? {}, qarvonAttributes)

  const updateResult = await updateChatwootContactCustomAttributes(clientConfig, contactId, mergedAttributes)
  if (!updateResult.ok) {
    await updateExternalEntityLinkMetadata(link.id, companyId, { last_sync_error: updateResult.error.message, last_sync_at: new Date().toISOString() })
    if (isPermanentChatwootError(updateResult.error)) {
      return success({ status: 'permanent_error', message: updateResult.error.message })
    }
    return success({ status: 'retryable_error', message: updateResult.error.message, retryAfterSeconds: updateResult.error.retryAfterSeconds })
  }

  await updateExternalEntityLinkMetadata(link.id, companyId, { last_synced_at: new Date().toISOString(), last_sync_error: null })

  return success({ status: 'synced', contactId })
}

export { QARVON_CUSTOM_ATTRIBUTES }
