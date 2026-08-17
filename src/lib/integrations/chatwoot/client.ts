/**
 * Cliente HTTP server-side canônico pra API do Chatwoot (Fase 4 — ERP →
 * Chatwoot). Único lugar do projeto que faz `fetch()` pro Chatwoot — nunca
 * espalhar chamada HTTP por services/routes (seção 2 do pedido).
 *
 * FONTES CONSULTADAS EM 2026-08-16 (mesma rigor da Fase 3 — WebSearch +
 * WebFetch, cruzando múltiplas páginas oficiais):
 *   - https://developers.chatwoot.com/api-reference/contacts/update-contact
 *     → PUT /api/v1/accounts/{account_id}/contacts/{id}
 *   - https://developers.chatwoot.com/api-reference/custom-attributes/add-a-new-custom-attribute
 *     → POST /api/v1/accounts/{account_id}/custom_attribute_definitions
 *   - https://developers.chatwoot.com/api-reference/custom-attributes/list-all-custom-attributes-in-an-account
 *     → GET /api/v1/accounts/{account_id}/custom_attribute_definitions
 *   - Autenticação: header `api_access_token` (nunca `Authorization: Bearer`
 *     — confirmado via múltiplas fontes, inclusive DeepWiki cruzado com a
 *     documentação oficial).
 *
 * INCERTEZA REGISTRADA: a documentação não especifica claramente se
 * `custom_attributes` no PUT de contato faz merge ou substitui os
 * atributos existentes. Por segurança (nunca sobrescrever atributo de
 * outro sistema/agente — seção 22), `updateChatwootContact()` sempre busca
 * o contato atual primeiro e faz o merge no lado do Qarvon antes de
 * enviar, então o comportamento real do Chatwoot (merge ou replace) não
 * importa pro resultado final.
 */

const DEFAULT_TIMEOUT_MS = 8000 // valor conservador nosso — não documentado oficialmente, ajustar aqui se necessário

export interface ChatwootClientConfig {
  baseUrl: string
  accountId: string
  apiToken: string
  timeoutMs?: number
}

export type ChatwootApiErrorKind = 'http' | 'timeout' | 'network' | 'invalid_base_url'

export interface ChatwootApiError {
  kind: ChatwootApiErrorKind
  status?: number
  retryAfterSeconds?: number
  message: string
}

export type ChatwootApiResult<T> = { ok: true; data: T } | { ok: false; error: ChatwootApiError }

/**
 * Erros permanentes — nunca vale retry (mesmo payload, mesma causa, vai
 * falhar de novo). 400 = request malformado. 401/403 = token/integração
 * inválidos. 404 = contato não existe mais no Chatwoot. 422 = payload
 * rejeitado pela validação do Chatwoot (seção 12 do pedido da Fase 5 —
 * "provavelmente permanente: 400, 401, 403, 404, 422" — lista revisada da
 * Fase 4, que não incluía 400).
 */
export function isPermanentChatwootError(error: ChatwootApiError): boolean {
  if (error.kind !== 'http') return false
  return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422
}

/**
 * Valida `base_url` antes de qualquer chamada (seção 43 — SSRF). Só
 * `https:` em produção; `http:` liberado fora de produção (mesmo padrão já
 * usado em `NUVEMSHOP_SKIP_WEBHOOK_HMAC`, nunca em produção). Bloqueia
 * qualquer outro esquema (`file:`, `ftp:`, `javascript:`, etc.) sempre.
 *
 * Threat model documentado (seção 43 do pedido): `base_url` só é definido
 * por configuração interna server-side (nunca por input de usuário final
 * nem por payload de webhook) — não bloqueamos IPs privados/internos
 * porque isso quebraria o caso legítimo de uma instância Chatwoot
 * self-hosted na mesma rede privada do servidor Qarvon (exatamente o
 * deployment real deste projeto). O risco residual aceito é um admin
 * comprometido apontando `base_url` pra uma URL interna arbitrária — fora
 * do escopo desta fase mitigar, documentado aqui por transparência.
 */
export function validateChatwootBaseUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'base_url não é uma URL válida.' }
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const allowedSchemes = isProduction ? ['https:'] : ['https:', 'http:']

  if (!allowedSchemes.includes(url.protocol)) {
    return { ok: false, reason: `Esquema de URL não permitido: ${url.protocol} (só ${allowedSchemes.join(', ')} ${isProduction ? 'em produção' : ''}).` }
  }

  return { ok: true, url }
}

async function chatwootFetch(
  config: ChatwootClientConfig,
  path: string,
  init: { method: string; body?: unknown },
): Promise<ChatwootApiResult<unknown>> {
  const validated = validateChatwootBaseUrl(config.baseUrl)
  if (!validated.ok) {
    return { ok: false, error: { kind: 'invalid_base_url', message: validated.reason } }
  }

  const url = `${validated.url.origin}/api/v1/accounts/${encodeURIComponent(config.accountId)}${path}`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Nunca desabilitar validação de TLS (sem rejectUnauthorized:false nem
    // equivalente) — certificado inválido deve falhar a chamada, sempre
    // (seção 44 do pedido). `fetch` nativo do Node já valida TLS por
    // padrão; não tocamos nisso.
    const response = await fetch(url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: config.apiToken,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('Retry-After')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // corpo de erro não-legível — segue sem ele
      }
      return {
        ok: false,
        error: {
          kind: 'http',
          status: response.status,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
          message: `Chatwoot respondeu ${response.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ''}`,
        },
      }
    }

    if (response.status === 204) return { ok: true, data: null }

    const contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.includes('application/json')) return { ok: true, data: null }

    const data = await response.json()
    return { ok: true, data }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: { kind: 'timeout', message: `Timeout (${timeoutMs}ms) chamando Chatwoot.` } }
    }
    return { ok: false, error: { kind: 'network', message: err instanceof Error ? err.message : 'Falha de rede desconhecida.' } }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export interface ChatwootContact {
  id: number
  name: string | null
  email: string | null
  phone_number: string | null
  custom_attributes: Record<string, unknown>
}

export async function getChatwootContact(
  config: ChatwootClientConfig,
  contactId: string,
): Promise<ChatwootApiResult<ChatwootContact>> {
  return chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}`, { method: 'GET' }) as Promise<ChatwootApiResult<ChatwootContact>>
}

/**
 * Atualiza SÓ `custom_attributes` — nunca envia `name`/`phone_number`/
 * `email`/`avatar`/`identifier` (seção 22: dados de identidade/atendimento
 * não são tocados por esta fase). `mergedCustomAttributes` já deve vir
 * mesclado com o que existia antes (ver nota de incerteza no cabeçalho).
 */
export async function updateChatwootContactCustomAttributes(
  config: ChatwootClientConfig,
  contactId: string,
  mergedCustomAttributes: Record<string, unknown>,
): Promise<ChatwootApiResult<ChatwootContact>> {
  return chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    body: { custom_attributes: mergedCustomAttributes },
  }) as Promise<ChatwootApiResult<ChatwootContact>>
}

export interface ChatwootCustomAttributeDefinition {
  id: number
  attribute_key: string
  attribute_display_name: string
  attribute_display_type: string
  attribute_model: string
}

export async function listChatwootCustomAttributeDefinitions(
  config: ChatwootClientConfig,
): Promise<ChatwootApiResult<ChatwootCustomAttributeDefinition[]>> {
  return chatwootFetch(config, '/custom_attribute_definitions', { method: 'GET' }) as Promise<ChatwootApiResult<ChatwootCustomAttributeDefinition[]>>
}

export interface CreateCustomAttributeDefinitionInput {
  attributeKey: string
  attributeDisplayName: string
  /** 0=text, 1=number, 2=currency, 3=percent, 4=link, 5=date, 6=list, 7=checkbox */
  attributeDisplayType: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  attributeDescription?: string
}

export async function createChatwootCustomAttributeDefinition(
  config: ChatwootClientConfig,
  input: CreateCustomAttributeDefinitionInput,
): Promise<ChatwootApiResult<ChatwootCustomAttributeDefinition>> {
  return chatwootFetch(config, '/custom_attribute_definitions', {
    method: 'POST',
    body: {
      attribute_key: input.attributeKey,
      attribute_display_name: input.attributeDisplayName,
      attribute_display_type: input.attributeDisplayType,
      attribute_description: input.attributeDescription ?? '',
      attribute_model: 1, // 1 = contact_attribute (confirmado via documentação oficial) — nunca 0 (conversation_attribute)
    },
  }) as Promise<ChatwootApiResult<ChatwootCustomAttributeDefinition>>
}

/**
 * Chamada leve e autorizada, sem alterar dados (seção 41 — health check):
 * lista as definições de atributo (endpoint já existente, `GET`, barato) só
 * pra confirmar token válido + account acessível + base_url correta.
 */
export async function testChatwootConnection(config: ChatwootClientConfig): Promise<ChatwootApiResult<{ reachable: true }>> {
  const result = await listChatwootCustomAttributeDefinitions(config)
  if (!result.ok) return result
  return { ok: true, data: { reachable: true } }
}

// ─── Fase N2B — resolver customer→Chatwoot (contact/conversation/message) ──────
//
// FONTES CONSULTADAS EM 2026-08-17 (WebFetch/WebSearch contra
// developers.chatwoot.com, mesmo rigor das fases anteriores):
//   - .../api-reference/contacts/search-contacts → GET /contacts/search?q=
//   - .../api-reference/contacts/create-contact → POST /contacts (requer inbox_id)
//   - .../api-reference/contacts/get-contactable-inboxes → GET /contacts/{id}/contactable_inboxes
//   - .../api-reference/contacts/create-contact-inbox → POST /contacts/{id}/contact_inboxes
//   - .../api-reference/contacts/contact-conversations → GET /contacts/{id}/conversations
//   - .../api-reference/conversations/create-new-conversation → POST /conversations
//     (requer `source_id` — obtido via contactable_inboxes/contact_inboxes, o
//     n8n nunca precisa conhecer esse valor, seção 3 do pedido)
//   - .../api-reference/messages/create-new-message → POST /conversations/{id}/messages

export interface ChatwootContactSearchResult {
  id: number
  name: string | null
  phone_number: string | null
  contact_inboxes: { source_id: string; inbox: { id: number } }[]
}

/** Busca por `q` (nome/identifier/email/telefone) — o chamador ainda precisa confirmar match exato de telefone (a busca do Chatwoot é fuzzy). */
export async function searchChatwootContacts(
  config: ChatwootClientConfig,
  query: string,
): Promise<ChatwootApiResult<ChatwootContactSearchResult[]>> {
  const result = await chatwootFetch(config, `/contacts/search?q=${encodeURIComponent(query)}`, { method: 'GET' })
  if (!result.ok) return result
  const payload = (result.data as { payload?: ChatwootContactSearchResult[] } | null)?.payload
  return { ok: true, data: payload ?? [] }
}

export interface CreateChatwootContactInput {
  inboxId: number
  name?: string | null
  phoneNumber: string
}

export interface CreatedChatwootContact {
  contact: ChatwootContactSearchResult
  /**
   * Confirmado via exemplo real de resposta (busca 2026-08-17): o POST de
   * criação devolve `payload.contact_inbox.source_id` pra inbox informada em
   * `inbox_id` — já pronto pra criar conversa nessa MESMA inbox sem precisar
   * de uma segunda chamada a `getContactableInboxes`.
   */
  sourceId: string
}

export async function createChatwootContact(
  config: ChatwootClientConfig,
  input: CreateChatwootContactInput,
): Promise<ChatwootApiResult<CreatedChatwootContact>> {
  const result = await chatwootFetch(config, '/contacts', {
    method: 'POST',
    body: { inbox_id: input.inboxId, name: input.name ?? undefined, phone_number: input.phoneNumber },
  })
  if (!result.ok) return result
  const payload = result.data as { payload?: { contact?: ChatwootContactSearchResult; contact_inbox?: { source_id?: string } } } | null
  const contact = payload?.payload?.contact
  const sourceId = payload?.payload?.contact_inbox?.source_id
  if (!contact || !sourceId) return { ok: false, error: { kind: 'http', message: 'Chatwoot não devolveu o contato/contact_inbox criado.' } }
  return { ok: true, data: { contact, sourceId } }
}

export interface ChatwootContactableInbox {
  source_id: string
  inbox: { id: number }
}

export async function getContactableInboxes(
  config: ChatwootClientConfig,
  contactId: string,
): Promise<ChatwootApiResult<ChatwootContactableInbox[]>> {
  const result = await chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}/contactable_inboxes`, { method: 'GET' })
  if (!result.ok) return result
  const payload = (result.data as { payload?: ChatwootContactableInbox[] } | null)?.payload
  return { ok: true, data: payload ?? [] }
}

/** Cria o vínculo contato↔inbox quando o contato ainda não tem `source_id` pra esta inbox — necessário antes de criar uma conversa nela. */
export async function createContactInbox(
  config: ChatwootClientConfig,
  contactId: string,
  inboxId: number,
): Promise<ChatwootApiResult<{ source_id: string }>> {
  return chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}/contact_inboxes`, {
    method: 'POST',
    body: { inbox_id: inboxId },
  }) as Promise<ChatwootApiResult<{ source_id: string }>>
}

export interface ChatwootConversationSummary {
  id: number
  status: 'open' | 'resolved' | 'pending' | 'snoozed'
  inbox_id: number
}

export async function listContactConversations(
  config: ChatwootClientConfig,
  contactId: string,
): Promise<ChatwootApiResult<ChatwootConversationSummary[]>> {
  const result = await chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}/conversations`, { method: 'GET' })
  if (!result.ok) return result
  const payload = (result.data as { payload?: ChatwootConversationSummary[] } | null)?.payload
  return { ok: true, data: payload ?? [] }
}

export interface CreateChatwootConversationInput {
  sourceId: string
  inboxId: number
  contactId: string
}

export async function createChatwootConversation(
  config: ChatwootClientConfig,
  input: CreateChatwootConversationInput,
): Promise<ChatwootApiResult<{ id: number; inbox_id: number }>> {
  return chatwootFetch(config, '/conversations', {
    method: 'POST',
    body: { source_id: input.sourceId, inbox_id: input.inboxId, contact_id: input.contactId },
  }) as Promise<ChatwootApiResult<{ id: number; inbox_id: number }>>
}

export interface ChatwootMessage {
  id: number
  content: string
}

/** Sempre `message_type: 'outgoing'`, `private: false` — este cliente nunca envia nota interna nem simula mensagem do cliente (seção 12 do pedido N2B: só mensagem outgoing real). */
export async function createChatwootMessage(
  config: ChatwootClientConfig,
  conversationId: string | number,
  content: string,
): Promise<ChatwootApiResult<ChatwootMessage>> {
  return chatwootFetch(config, `/conversations/${encodeURIComponent(String(conversationId))}/messages`, {
    method: 'POST',
    body: { content, message_type: 'outgoing', private: false },
  }) as Promise<ChatwootApiResult<ChatwootMessage>>
}
