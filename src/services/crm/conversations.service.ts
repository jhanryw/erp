/**
 * Service de CRM — Conversas (crm_conversations).
 *
 * Vincula um crm_channels (canal operacional da empresa) a um
 * crm_channel_identities (identidade de canal de uma pessoa) — os dois são
 * independentes desde a Entrega 1 (o mesmo número de uma pessoa pode ser
 * alcançado por mais de um WhatsApp da empresa), então nada no banco garante
 * que os dois tenham o mesmo channel_type. channelAndIdentityMatch() é essa
 * checagem, aqui na service layer, mesma categoria de
 * entityBelongsToCompany()/organizationAndPersonBelongToCompany().
 *
 * findOrCreateConversation() é a operação de "create" real: existe no máximo
 * uma conversa open/pending por (channel_id, channel_identity_id) — índice
 * único parcial no banco é a rede de segurança contra corrida, esta função
 * tenta achar antes de inserir e trata 23505 como "outra chamada venceu a
 * corrida" (relê e retorna a existente, não é erro).
 *
 * Entrega 2 (Fase 3): create (find-or-create)/get/list + updateStatus (sem
 * consumidor ainda — API/UI ficam para a Entrega 3).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmConversation, CrmConversationStatus, CrmChannelType, CrmMessageContentType, CrmMessageDirection, CrmMessageStatus } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface FindOrCreateConversationInput {
  companyId: number
  channelId: number
  channelIdentityId: number
  personId: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Verificação de posse e coerência ─────────────────────────────────────────

/**
 * Confirma que channel_id e channel_identity_id pertencem à empresa e têm
 * o mesmo channel_type, e que channel_identity_id realmente pertence a
 * person_id. Nenhuma dessas checagens é impositível por FK simples entre
 * tabelas diferentes.
 */
export async function channelAndIdentityMatch(
  channelId: number,
  channelIdentityId: number,
  personId: number,
  companyId: number,
): Promise<boolean> {
  const admin = createAdminClient()

  const { data: channel } = await admin
    .from('crm_channels')
    .select('id, channel_type')
    .eq('id', channelId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number; channel_type: string } | null }

  const { data: identity } = await admin
    .from('crm_channel_identities')
    .select('id, channel_type, person_id')
    .eq('id', channelIdentityId)
    .eq('company_id', companyId)
    .eq('person_id', personId)
    .maybeSingle() as unknown as { data: { id: number; channel_type: string; person_id: number } | null }

  if (!channel || !identity) return false
  return channel.channel_type === identity.channel_type
}

// ─── Operações ─────────────────────────────────────────────────────────────────

async function selectOpenOrPending(
  admin: ReturnType<typeof createAdminClient>,
  channelId: number,
  channelIdentityId: number,
): Promise<CrmConversation | null> {
  const { data } = await admin
    .from('crm_conversations')
    .select('*')
    .eq('channel_id', channelId)
    .eq('channel_identity_id', channelIdentityId)
    .in('status', ['open', 'pending'])
    .maybeSingle() as unknown as { data: CrmConversation | null }
  return data
}

/**
 * Encontra a conversa open/pending para (channel_id, channel_identity_id),
 * reabre a mais recente 'closed' se existir, ou cria uma nova. Chamada
 * exclusivamente pela ingestão inbound (Entrega 10) — único consumidor
 * confirmado, sem outro caller que dependesse do comportamento anterior
 * ("nunca reabre sozinho").
 *
 * Reabertura por decisão explícita do usuário (Entrega 10): histórico
 * contínuo por canal/identidade, consistente com o outbound (Entrega 6),
 * que já reabre conversa fechada ao enviar.
 *
 * Segurança sob concorrência, SEM RPC/advisory lock novo — auditoria
 * confirmou que o índice único parcial existente
 * (uq_crm_conversations_open_per_identity) já é suficiente:
 *   - Reabrir NUNCA cria linha nova — só transiciona uma linha já
 *     identificada deterministicamente (a 'closed' de maior id). Duas
 *     chamadas concorrentes que leem a mesma candidata convergem pra UM
 *     UPDATE efetivo; a segunda tem `WHERE status='closed'` que não bate
 *     mais (0 linhas afetadas) e relê o open/pending já reaberto pela
 *     primeira — nunca duas linhas abertas.
 *   - No caso (raríssimo) de outra chamada ter reaberto/criado uma
 *     conversa DIFERENTE pra mesma identidade entre o SELECT e o UPDATE, o
 *     próprio índice único barra o UPDATE com 23505 — tratado abaixo do
 *     mesmo jeito que o INSERT já trata (relê e devolve a que venceu).
 *   - Conversa nunca fica 'closed' por nenhum caminho do inbound (só a
 *     ação manual da Entrega 9 fecha) — não existe "fechamento fantasma"
 *     no meio da corrida pra invalidar a escolha da candidata.
 *   - O INSERT final (quando não há open/pending nem closed pra reabrir)
 *     mantém a mesma proteção de sempre (23505 → relê).
 */
export async function findOrCreateConversation(
  input: FindOrCreateConversationInput,
): Promise<ServiceOutcome<CrmConversation>> {
  const matches = await channelAndIdentityMatch(input.channelId, input.channelIdentityId, input.personId, input.companyId)
  if (!matches) {
    return failure('Canal e identidade de canal não são compatíveis (empresa, pessoa ou channel_type divergem).', 422)
  }

  const admin = createAdminClient()

  const existing = await selectOpenOrPending(admin, input.channelId, input.channelIdentityId)
  if (existing) return success(existing)

  const { data: closedCandidate } = await admin
    .from('crm_conversations')
    .select('*')
    .eq('channel_id', input.channelId)
    .eq('channel_identity_id', input.channelIdentityId)
    .eq('status', 'closed')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle() as unknown as { data: CrmConversation | null }

  if (closedCandidate) {
    const { data: reopened, error: reopenError } = await (admin as any)
      .from('crm_conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', closedCandidate.id)
      .eq('status', 'closed') // guarda condicional — só aplica se ninguém mudou o status entre o SELECT e aqui
      .select('*')
      .maybeSingle() as unknown as { data: CrmConversation | null; error: { code?: string; message: string } | null }

    if (reopenError) {
      if (reopenError.code === '23505') {
        // Outra chamada concorrente já é dona do slot open/pending desta
        // identidade agora — devolve ela em vez de errar.
        const retried = await selectOpenOrPending(admin, input.channelId, input.channelIdentityId)
        if (retried) return success(retried)
      }
      return failure(reopenError.message)
    }

    if (reopened) return success(reopened)

    // UPDATE não afetou nenhuma linha — outra chamada já reabriu (ou fechou
    // de novo) essa mesma conversa entre o SELECT e o UPDATE. Relê.
    const retried = await selectOpenOrPending(admin, input.channelId, input.channelIdentityId)
    if (retried) return success(retried)
  }

  const { data, error } = await admin
    .from('crm_conversations')
    .insert({
      company_id: input.companyId,
      channel_id: input.channelId,
      channel_identity_id: input.channelIdentityId,
      person_id: input.personId,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmConversation | null; error: { code?: string; message: string } | null }

  if (error) {
    if (error.code === '23505') {
      const retried = await selectOpenOrPending(admin, input.channelId, input.channelIdentityId)
      if (retried) return success(retried)
    }
    return failure(error.message)
  }

  return success(data!)
}

export async function getConversation(conversationId: number, companyId: number): Promise<ServiceOutcome<CrmConversation>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmConversation | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Conversa não encontrada.', 404)
  return success(data)
}

export async function listConversationsByPerson(
  personId: number,
  companyId: number,
  options?: { status?: CrmConversationStatus },
): Promise<ServiceOutcome<CrmConversation[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_conversations')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (options?.status) query = query.eq('status', options.status)

  const { data, error } = await query.order('last_message_at', { ascending: false, nullsFirst: false }) as {
    data: CrmConversation[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Transição de status (ex.: encerrar/reabrir conversa). Consumida desde a
 * Entrega 6 (outbound reabre conversa 'closed' ao enviar) e pela Inbox
 * (Entrega 7, botão de encerrar/reabrir; Entrega 9, ação manual de
 * abrir/pendente/encerrar). Transições livres entre os 3 status — sem
 * máquina de estados (decisão explícita do usuário na Entrega 9).
 *
 * Risco encontrado na auditoria da Entrega 9: existe no máximo 1 conversa
 * 'open'/'pending' por (channel_id, channel_identity_id) — índice único
 * parcial (Entrega 2). Reabrir manualmente uma conversa 'closed' quando já
 * existe outra 'open'/'pending' pro mesmo canal/identidade viola esse
 * índice — tratado aqui como 409 com mensagem clara, não como 500 genérico.
 */
export async function updateConversationStatus(
  conversationId: number,
  companyId: number,
  status: CrmConversationStatus,
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('crm_conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('company_id', companyId) as { error: { code?: string; message: string } | null }

  if (error) {
    if (error.code === '23505') {
      return failure('Já existe outra conversa aberta ou pendente para este mesmo contato/canal — encerre-a antes de reabrir esta.', 409)
    }
    return failure(error.message)
  }
  return success(undefined)
}

/**
 * Contagem de conversas por status, empresa inteira — independente de
 * filtro/paginação da listagem (Entrega 9). Uma query de agregação, sem
 * relação com listConversations().
 */
export interface ConversationCounts {
  open: number
  pending: number
  closed: number
}

export async function getConversationCounts(companyId: number): Promise<ServiceOutcome<ConversationCounts>> {
  const admin = createAdminClient()

  // 3 COUNT(*) leves (head: true — não traz linhas), não uma listagem
  // completa contada em memória; escala independente do total de conversas.
  const [openResult, pendingResult, closedResult] = await Promise.all(
    (['open', 'pending', 'closed'] as const).map((status) =>
      admin
        .from('crm_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', status) as unknown as Promise<{ count: number | null; error: { message: string } | null }>
    )
  )

  for (const result of [openResult, pendingResult, closedResult]) {
    if (result.error) return failure(result.error.message)
  }

  return success({
    open: openResult.count ?? 0,
    pending: pendingResult.count ?? 0,
    closed: closedResult.count ?? 0,
  })
}

// ─── Listagem company-wide (Entrega 7 — Inbox) ────────────────────────────────

export interface ConversationListItemPerson {
  id: number
  displayName: string
}

export interface ConversationListItemChannel {
  id: number
  name: string
  channelType: CrmChannelType
}

export interface ConversationListItemLastMessage {
  content: string | null
  contentType: CrmMessageContentType
  direction: CrmMessageDirection
  status: CrmMessageStatus
  createdAt: string
}

export interface ConversationListItemChannelIdentity {
  id: number
  value: string
}

export interface ConversationListItem {
  id: number
  channelId: number
  channelIdentityId: number
  personId: number
  status: CrmConversationStatus
  lastMessageAt: string | null
  createdAt: string
  person: ConversationListItemPerson | null
  channel: ConversationListItemChannel | null
  channelIdentity: ConversationListItemChannelIdentity | null
  lastMessage: ConversationListItemLastMessage | null
}

export interface ListConversationsOptions {
  status?: CrmConversationStatus
  channelId?: number
  personId?: number
  /** Nome da pessoa, valor da identidade de canal (telefone/handle) ou
   *  conteúdo da última mensagem — via rpc_search_crm_conversations()
   *  (Entrega 9), nunca `.or()` concatenado com o termo do usuário. */
  search?: string
  limit?: number
  offset?: number
}

export interface ListConversationsResult {
  conversations: ConversationListItem[]
  hasMore: boolean
}

const DEFAULT_LIST_LIMIT = 30

/**
 * Lista conversas de toda a empresa (não de uma pessoa só — diferente de
 * listConversationsByPerson) — é a consulta principal da Inbox. Resolve
 * pessoa/canal/identidade via embedded select (FK direta) e a última
 * mensagem via v_crm_conversation_last_message numa segunda query em lote
 * (não é FK, não dá pra embutir no mesmo select) — 2 queries fixas
 * (+ 1 extra só quando `search` é usado), nunca N+1 independente de
 * quantas conversas vierem na página.
 */
export async function listConversations(
  companyId: number,
  options?: ListConversationsOptions,
): Promise<ServiceOutcome<ListConversationsResult>> {
  const admin = createAdminClient()
  const limit = options?.limit ?? DEFAULT_LIST_LIMIT
  const offset = options?.offset ?? 0

  // Busca (Entrega 9): resolve os IDs que batem via RPC com parâmetro
  // bindado (nunca `.or()` concatenado com o termo digitado pelo usuário —
  // ver comentário da migration 20260715), ANTES da query principal.
  // Termo vazio/sem resultado nunca chama a query principal à toa.
  const search = options?.search?.trim()
  let searchMatchIds: number[] | null = null
  if (search) {
    const { data: matches, error: searchError } = await (admin as any)
      .rpc('rpc_search_crm_conversations', { p_company_id: companyId, p_search: search }) as unknown as {
        data: Array<{ conversation_id: number }> | null
        error: { message: string } | null
      }
    if (searchError) return failure(searchError.message)
    searchMatchIds = (matches ?? []).map((row) => row.conversation_id)
    if (searchMatchIds.length === 0) return success({ conversations: [], hasMore: false })
  }

  let query = (admin as any)
    .from('crm_conversations')
    .select('id, channel_id, channel_identity_id, person_id, status, last_message_at, created_at, person:person_id(id,display_name), channel:channel_id(id,name,channel_type), channel_identity:channel_identity_id(id,value)')
    .eq('company_id', companyId)

  if (options?.status) query = query.eq('status', options.status)
  if (options?.channelId) query = query.eq('channel_id', options.channelId)
  if (options?.personId) query = query.eq('person_id', options.personId)
  if (searchMatchIds) query = query.in('id', searchMatchIds)

  const { data, error } = await query
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit) as {
      data: Array<{
        id: number; channel_id: number; channel_identity_id: number; person_id: number
        status: CrmConversationStatus; last_message_at: string | null; created_at: string
        person: { id: number; display_name: string } | null
        channel: { id: number; name: string; channel_type: CrmChannelType } | null
        channel_identity: { id: number; value: string } | null
      }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)

  const rows = data ?? []
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  const conversationIds = page.map((row) => row.id)
  const lastMessageByConversation = new Map<number, ConversationListItemLastMessage>()

  if (conversationIds.length > 0) {
    const { data: lastMessages, error: lastMessagesError } = await admin
      .from('v_crm_conversation_last_message')
      .select('conversation_id, content, content_type, direction, status, created_at')
      .in('conversation_id', conversationIds) as unknown as {
        data: Array<{
          conversation_id: number; content: string | null; content_type: CrmMessageContentType
          direction: CrmMessageDirection; status: CrmMessageStatus; created_at: string
        }> | null
        error: { message: string } | null
      }

    if (lastMessagesError) return failure(lastMessagesError.message)

    for (const row of lastMessages ?? []) {
      lastMessageByConversation.set(row.conversation_id, {
        content: row.content,
        contentType: row.content_type,
        direction: row.direction,
        status: row.status,
        createdAt: row.created_at,
      })
    }
  }

  const conversations: ConversationListItem[] = page.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    channelIdentityId: row.channel_identity_id,
    personId: row.person_id,
    status: row.status,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    person: row.person ? { id: row.person.id, displayName: row.person.display_name } : null,
    channel: row.channel ? { id: row.channel.id, name: row.channel.name, channelType: row.channel.channel_type } : null,
    channelIdentity: row.channel_identity ? { id: row.channel_identity.id, value: row.channel_identity.value } : null,
    lastMessage: lastMessageByConversation.get(row.id) ?? null,
  }))

  return success({ conversations, hasMore })
}
