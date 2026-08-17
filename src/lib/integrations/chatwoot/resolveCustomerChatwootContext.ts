/**
 * FASE N2B — Resolver canônico customer → Chatwoot (contact/conversation).
 *
 * Objetivo central do pedido: o n8n NUNCA precisa conhecer account_id,
 * inbox_id, contact_id resolution, source_id, conversation lookup/creation,
 * external_entity_links, crm_person ou secrets do Chatwoot — só chama este
 * resolver (via `POST /api/automations/chatwoot/resolve`, Fase N2B) e recebe
 * de volta `{customer_id, contact_id, conversation_id, inbox_id}` prontos.
 *
 * Reaproveita 100% a infraestrutura já existente, nenhuma tabela nova:
 *   - normalizeE164BR (Fase 1)
 *   - resolvePersonForCustomer (Fase 4, reconciliation.ts)
 *   - findOrCreateChannelIdentity + linkPersonToCustomerIfConfident (Fase 1/3
 *     — mesmo caminho já usado pelo webhook inbound do Chatwoot, contactResolver.ts)
 *   - getCompanyIntegration / getIntegrationSecret / findLinkForEntity /
 *     linkExternalEntity (Fase 2)
 *   - client.ts (Fase 4, estendido nesta fase com search/create contact,
 *     contact_inboxes, conversations, message)
 *
 * Ordem de resolução (seções 2-8 do pedido):
 *   1. customer (customer_id tem prioridade sobre phone)
 *   2. integração Chatwoot ativa + settings.inbox_id + api_token
 *   3. crm_person (via crm_person_customer_links; cria um novo se a
 *      customer nunca teve identidade de canal — caso legítimo pra clientes
 *      cadastrados só pelo ERP, nunca via WhatsApp/CRM)
 *   4. contact Chatwoot (link existente → reaproveita; senão busca por
 *      telefone no Chatwoot → reaproveita; senão cria)
 *   5. conversation (open > pending reaproveitados; nunca reusa `resolved`
 *      nem de outra inbox — ver nota de incerteza abaixo; senão cria nova)
 *
 * INCERTEZA REGISTRADA (mesmo espírito da Fase 3 — decisão explícita, não
 * confirmada contra uma instância real): a documentação do Chatwoot não
 * define uma regra universal sobre reabrir conversas `resolved`. Decidido
 * NUNCA reaproveitar `resolved` automaticamente — uma automação que dispara
 * depois que o atendimento já foi encerrado deveria abrir uma conversa NOVA,
 * não reabrir silenciosamente uma antiga (evita reviver threads antigas sem
 * contexto pro agente). Revisável se o comportamento real do Chatwoot mostrar
 * outra necessidade.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeE164BR } from '@/lib/utils/phone'
import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import { findLinkForEntity, linkExternalEntity } from '@/services/integrations/external-entity-links.service'
import { resolvePersonForCustomer } from './reconciliation'
import { linkPersonToCustomerIfConfident } from '@/services/crm/customer-identity.service'
import { findOrCreateChannelIdentity } from '@/services/crm/channel-identities.service'
import {
  searchChatwootContacts,
  createChatwootContact,
  getContactableInboxes,
  createContactInbox,
  listContactConversations,
  createChatwootConversation,
  createChatwootMessage,
  isPermanentChatwootError,
  type ChatwootClientConfig,
  type ChatwootApiError,
} from './client'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ResolveCustomerChatwootContextInput {
  customerId?: number
  phone?: string
}

export type ResolveContextOutcome =
  | { status: 'resolved'; customerId: number; contactId: number; conversationId: number; inboxId: number }
  | { status: 'customer_not_found' }
  | { status: 'ambiguous_customer' }
  | { status: 'anonymous_customer' }
  /** Customer existe mas nunca teve `phone_e164` calculado — sem telefone não há como resolver/criar contato Chatwoot (nem crm_person). Fora da lista fixa da seção 10 do pedido, documentado aqui e no relatório. */
  | { status: 'customer_missing_phone' }
  /** Cobre TANTO "crm_person ambígua pra este customer" QUANTO "2+ contatos Chatwoot batem com o mesmo telefone" — nos dois casos, mesma regra: nunca escolher um arbitrariamente. */
  | { status: 'contact_ambiguous' }
  | { status: 'chatwoot_not_configured'; message: string }
  | { status: 'chatwoot_unavailable'; message: string; permanent: boolean; retryAfterSeconds?: number }

interface CustomerRow {
  id: number
  name: string | null
  phone_e164: string | null
  is_anonymous: boolean
}

function chatwootUnavailableOutcome(error: ChatwootApiError): { status: 'chatwoot_unavailable'; message: string; permanent: boolean; retryAfterSeconds?: number } {
  return { status: 'chatwoot_unavailable', message: error.message, permanent: isPermanentChatwootError(error), retryAfterSeconds: error.retryAfterSeconds }
}

/** Resultado interno — carrega `config` (inclui `apiToken`) SÓ dentro deste módulo, nunca exposto pelas funções exportadas (`resolveCustomerChatwootContext`/`sendChatwootMessageToCustomer` sempre removem `config` antes de devolver). */
type InternalResolveResult =
  | { status: 'resolved'; customerId: number; contactId: number; conversationId: number; inboxId: number; config: ChatwootClientConfig }
  | Exclude<ResolveContextOutcome, { status: 'resolved' }>

// ─── Resolução de customer (seções 2/4 do pedido) ──────────────────────────────

type CustomerResolutionFailure = Exclude<ResolveContextOutcome, { status: 'resolved' }>

async function resolveCustomerRow(
  companyId: number,
  input: ResolveCustomerChatwootContextInput,
): Promise<ServiceOutcome<{ customer: CustomerRow } | { outcome: CustomerResolutionFailure }>> {
  if (input.customerId != null) {
    const admin = createAdminClient()
    const { data, error } = await (admin as any)
      .from('customers')
      .select('id, name, phone_e164, is_anonymous')
      .eq('id', input.customerId)
      .eq('company_id', companyId)
      .maybeSingle() as { data: CustomerRow | null; error: { message: string } | null }
    if (error) return failure(error.message)
    if (!data) return success({ outcome: { status: 'customer_not_found' } })
    if (data.is_anonymous) return success({ outcome: { status: 'anonymous_customer' } })
    return success({ customer: data })
  }

  if (input.phone) {
    const phoneE164 = normalizeE164BR(input.phone)
    if (!phoneE164) return success({ outcome: { status: 'customer_not_found' } })

    const admin = createAdminClient()
    const { data, error } = await (admin as any)
      .from('customers')
      .select('id, name, phone_e164, is_anonymous')
      .eq('company_id', companyId)
      .eq('phone_e164', phoneE164)
      .eq('is_anonymous', false) as { data: CustomerRow[] | null; error: { message: string } | null }
    if (error) return failure(error.message)

    const matches = data ?? []
    if (matches.length === 0) return success({ outcome: { status: 'customer_not_found' } })
    if (matches.length > 1) return success({ outcome: { status: 'ambiguous_customer' } })
    return success({ customer: matches[0] })
  }

  return failure('Informe "customer_id" ou "phone".', 422)
}

// ─── Operação principal (interna — ver InternalResolveResult acima) ────────────

async function resolveInternal(
  companyId: number,
  input: ResolveCustomerChatwootContextInput,
): Promise<ServiceOutcome<InternalResolveResult>> {
  const customerResult = await resolveCustomerRow(companyId, input)
  if (!customerResult.ok) return failure(customerResult.error, customerResult.status)
  if ('outcome' in customerResult.data) return success(customerResult.data.outcome)

  const customer = customerResult.data.customer
  if (!customer.phone_e164) return success({ status: 'customer_missing_phone' })

  // ── Integração Chatwoot ativa + configuração completa ──────────────────────
  const integrationResult = await getCompanyIntegration(companyId, 'chatwoot')
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  const integration = integrationResult.data
  if (!integration || integration.status !== 'active') {
    return success({ status: 'chatwoot_not_configured', message: 'Integração Chatwoot não configurada/ativa para esta empresa.' })
  }

  const rawInboxId = integration.settings.inbox_id
  const inboxId = typeof rawInboxId === 'number' ? rawInboxId : typeof rawInboxId === 'string' ? Number(rawInboxId) : NaN
  if (!Number.isFinite(inboxId) || inboxId <= 0) {
    return success({ status: 'chatwoot_not_configured', message: 'settings.inbox_id não configurado para esta integração (seção 7 do pedido N2B).' })
  }

  const baseUrl = typeof integration.settings.base_url === 'string' ? integration.settings.base_url : null
  if (!baseUrl) return success({ status: 'chatwoot_not_configured', message: 'settings.base_url não configurado para esta integração.' })

  const apiTokenResult = await getIntegrationSecret(integration.id, companyId, 'api_token')
  if (!apiTokenResult.ok) return failure(apiTokenResult.error, apiTokenResult.status)
  if (!apiTokenResult.data) return success({ status: 'chatwoot_not_configured', message: 'api_token não configurado para esta integração.' })

  const config: ChatwootClientConfig = { baseUrl, accountId: integration.external_account_id ?? '', apiToken: apiTokenResult.data }

  // ── crm_person (seções 4-5 do pedido) ───────────────────────────────────────
  const personResult = await resolvePersonForCustomer(customer.id, companyId)
  if (!personResult.ok) return failure(personResult.error, personResult.status)

  let personId: number
  if (personResult.data.status === 'ambiguous') {
    return success({ status: 'contact_ambiguous' })
  } else if (personResult.data.status === 'resolved') {
    personId = personResult.data.personId
  } else {
    // Customer nunca teve identidade de canal (cadastro só pelo ERP) — cria
    // via o MESMO mecanismo do webhook inbound (Fase 3), advisory lock
    // incluso, nenhuma lógica de criação nova.
    const createdIdentity = await findOrCreateChannelIdentity({
      companyId,
      channelType: 'whatsapp',
      value: customer.phone_e164,
      displayNameHint: customer.name,
      personCreatedSource: 'other',
      identityCreatedSource: 'other',
    })
    if (!createdIdentity.ok) return failure(createdIdentity.error, createdIdentity.status)
    personId = createdIdentity.data.personId
    // Best-effort — mesmo telefone que acabamos de anexar deve resolver
    // HIGH_CONFIDENCE pra este exato customer; não bloqueia o fluxo se, por
    // algum motivo (duplicidade de telefone já conhecida), vier ambíguo.
    await linkPersonToCustomerIfConfident(personId, companyId)
  }

  // ── Contato Chatwoot (seção 6 do pedido) ────────────────────────────────────
  const linkResult = await findLinkForEntity(integration.id, 'crm_person', personId, 'contact')
  if (!linkResult.ok) return failure(linkResult.error, linkResult.status)

  let contactId: string
  let freshSourceId: string | null = null

  if (linkResult.data) {
    contactId = linkResult.data.external_id
  } else {
    const searchResult = await searchChatwootContacts(config, customer.phone_e164)
    if (!searchResult.ok) return success(chatwootUnavailableOutcome(searchResult.error))

    // A busca do Chatwoot é fuzzy (nome/identifier/email/telefone) — só
    // confia em match de TELEFONE EXATO, nunca escolhe por nome parecido.
    const exactMatches = searchResult.data.filter(
      (c) => c.phone_number && normalizeE164BR(c.phone_number) === customer.phone_e164,
    )

    if (exactMatches.length > 1) return success({ status: 'contact_ambiguous' })

    if (exactMatches.length === 1) {
      contactId = String(exactMatches[0].id)
    } else {
      const createResult = await createChatwootContact(config, {
        inboxId,
        phoneNumber: `+${customer.phone_e164}`,
        name: customer.name,
      })
      if (!createResult.ok) return success(chatwootUnavailableOutcome(createResult.error))
      contactId = String(createResult.data.contact.id)
      freshSourceId = createResult.data.sourceId
    }

    const linkCreate = await linkExternalEntity({
      companyId,
      integrationId: integration.id,
      provider: 'chatwoot',
      entityType: 'crm_person',
      entityId: personId,
      externalEntityType: 'contact',
      externalId: contactId,
    })
    if (!linkCreate.ok) {
      if (linkCreate.status !== 409) return failure(linkCreate.error, linkCreate.status)
      // Corrida: outra chamada concorrente já criou o vínculo pra esta
      // pessoa entre nosso findLinkForEntity e agora — usa o vencedor real
      // (idempotência sob concorrência, seção 9 do pedido).
      const refetch = await findLinkForEntity(integration.id, 'crm_person', personId, 'contact')
      if (!refetch.ok) return failure(refetch.error, refetch.status)
      if (refetch.data) {
        contactId = refetch.data.external_id
        freshSourceId = null // não sabemos se é o mesmo contato que acabamos de criar — resolve source_id de novo abaixo
      }
    }
  }

  // ── Conversation (seção 8 do pedido) ────────────────────────────────────────
  const conversationsResult = await listContactConversations(config, contactId)
  if (!conversationsResult.ok) return success(chatwootUnavailableOutcome(conversationsResult.error))

  // Nunca reaproveita conversa de OUTRA inbox (seção 8: "não reutilizar uma
  // conversa de outro inbox").
  const inInbox = conversationsResult.data.filter((c) => c.inbox_id === inboxId)
  const reusable = inInbox.find((c) => c.status === 'open') ?? inInbox.find((c) => c.status === 'pending')

  let conversationId: number

  if (reusable) {
    conversationId = reusable.id
  } else {
    let sourceId = freshSourceId
    if (!sourceId) {
      const contactableResult = await getContactableInboxes(config, contactId)
      if (!contactableResult.ok) return success(chatwootUnavailableOutcome(contactableResult.error))
      const match = contactableResult.data.find((ci) => ci.inbox.id === inboxId)
      if (match) {
        sourceId = match.source_id
      } else {
        const createdInbox = await createContactInbox(config, contactId, inboxId)
        if (!createdInbox.ok) return success(chatwootUnavailableOutcome(createdInbox.error))
        sourceId = createdInbox.data.source_id
      }
    }

    const createConvResult = await createChatwootConversation(config, { sourceId, inboxId, contactId })
    if (!createConvResult.ok) return success(chatwootUnavailableOutcome(createConvResult.error))
    conversationId = createConvResult.data.id
  }

  return success({
    status: 'resolved',
    customerId: customer.id,
    contactId: Number(contactId),
    conversationId,
    inboxId,
    config,
  })
}

// ─── API pública ────────────────────────────────────────────────────────────

/**
 * Resolução SÓ do customer (nenhuma chamada ao Chatwoot) — usada por
 * `POST /api/automations/chatwoot/send` pra saber o `customer_id` real
 * ANTES de reivindicar a `idempotency_key` (seção 13 do pedido: precisa do
 * `customer_id` pra registrar o claim, mas reivindicar a chave tem que
 * acontecer ANTES de qualquer chamada ao Chatwoot que possa enviar
 * mensagem — senão um retry com a mesma chave reenviaria antes de a
 * duplicidade ser detectada).
 */
export async function resolveCustomerIdForAutomation(
  companyId: number,
  input: ResolveCustomerChatwootContextInput,
): Promise<ServiceOutcome<{ customerId: number } | { outcome: CustomerResolutionFailure }>> {
  const result = await resolveCustomerRow(companyId, input)
  if (!result.ok) return result
  if ('outcome' in result.data) return success({ outcome: result.data.outcome })
  const customer = result.data.customer
  if (!customer.phone_e164) return success({ outcome: { status: 'customer_missing_phone' } })
  return success({ customerId: customer.id })
}

/** Usado por `POST /api/automations/chatwoot/resolve` — nunca expõe `config` (contém `apiToken`). */
export async function resolveCustomerChatwootContext(
  companyId: number,
  input: ResolveCustomerChatwootContextInput,
): Promise<ServiceOutcome<ResolveContextOutcome>> {
  const result = await resolveInternal(companyId, input)
  if (!result.ok) return result
  if (result.data.status !== 'resolved') return success(result.data)

  const { config: _config, ...outcome } = result.data
  return success(outcome)
}

export type SendChatwootMessageOutcome =
  | { status: 'sent'; customerId: number; conversationId: number; messageId: number }
  | Exclude<ResolveContextOutcome, { status: 'resolved' }>

/**
 * Usado por `POST /api/automations/chatwoot/send` — resolve o contexto (o
 * MESMO caminho de `resolveCustomerChatwootContext`, contato/conversa
 * idempotentes) e, só se resolvido, envia a mensagem. `config` (com
 * `apiToken`) nunca sai deste módulo — a rota nunca vê o token do Chatwoot.
 */
export async function sendChatwootMessageToCustomer(
  companyId: number,
  input: ResolveCustomerChatwootContextInput,
  content: string,
): Promise<ServiceOutcome<SendChatwootMessageOutcome>> {
  const result = await resolveInternal(companyId, input)
  if (!result.ok) return result
  if (result.data.status !== 'resolved') return success(result.data)

  const { config, conversationId, customerId } = result.data
  const sendResult = await createChatwootMessage(config, conversationId, content)
  if (!sendResult.ok) return success(chatwootUnavailableOutcome(sendResult.error))

  return success({ status: 'sent', customerId, conversationId, messageId: sendResult.data.id })
}
