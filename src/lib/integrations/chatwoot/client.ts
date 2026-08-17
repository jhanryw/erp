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
 * falhar de novo). 401/403 = token/integração inválidos. 404 = contato não
 * existe mais no Chatwoot. 422 = payload rejeitado pela validação do
 * Chatwoot (seção 33 do pedido).
 */
export function isPermanentChatwootError(error: ChatwootApiError): boolean {
  if (error.kind !== 'http') return false
  return error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422
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
