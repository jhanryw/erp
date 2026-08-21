/**
 * Cliente HTTP isolado da Focus NFe (Fase Fiscal 1 — fundação; estendido
 * na Fase Fiscal 2A para cadastro de empresa).
 *
 * Autenticação: HTTP Basic com o token como usuário e senha vazia
 * (confirmado na doc oficial — não é Bearer, não é header customizado).
 * Base URL varia por ambiente (`FOCUS_BASE_URLS`) — homologação e produção
 * usam hosts e tokens completamente diferentes, nunca compartilhados.
 *
 * Fase Fiscal 2B: adiciona `issueFocusNfe` (emissão real, `POST /v2/nfe`)
 * — só usado pelo transmission service, nunca automaticamente (sem
 * automação via outbox/sale.completed nesta fase). Cancelamento
 * (`DELETE /v2/nfe/{ref}`) continua fora de escopo. Ver types.ts e
 * docs/fiscal-fase2a-payload-nfe.md / docs/fiscal-fase2b-*.md.
 */

import { FOCUS_BASE_URLS, FocusApiError, type FocusEmpresa, type FocusEmpresaInput, type FocusNfeConsultaResponse, type FocusNfceConsultaResponse, type FocusRequestOptions } from './types'

const DEFAULT_TIMEOUT_MS = 15_000

function basicAuthHeader(token: string): string {
  // usuário = token, senha vazia — formato exigido pela Focus.
  return `Basic ${Buffer.from(`${token}:`).toString('base64')}`
}

async function focusRequest<T>(
  path: string,
  options: FocusRequestOptions,
  init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
): Promise<T> {
  const baseUrl = FOCUS_BASE_URLS[options.environment]
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const method = init?.method ?? 'GET'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: basicAuthHeader(options.token),
        Accept: 'application/json',
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Focus NFe: tempo limite (${timeoutMs}ms) excedido ao chamar ${path}.`)
    }
    throw new Error(`Focus NFe: falha de rede ao chamar ${path} — ${err instanceof Error ? err.message : 'erro desconhecido'}.`)
  } finally {
    clearTimeout(timeout)
  }

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    throw new FocusApiError(response.status, body)
  }

  return body as T
}

/**
 * `GET /v2/empresas` — lista empresas visíveis pro token. Usado como
 * health-check de credencial (Fase 1) e, com `cnpj`, pra resolver se a
 * empresa já está cadastrada na Focus antes de criar/atualizar (Fase 2A).
 * Filtro por CNPJ confirmado na doc (`?cnpj=<14 dígitos>`).
 */
export async function listFocusEmpresas(options: FocusRequestOptions, cnpj?: string): Promise<FocusEmpresa[]> {
  const query = cnpj ? `?cnpj=${encodeURIComponent(cnpj.replace(/\D/g, ''))}` : ''
  return focusRequest<FocusEmpresa[]>(`/v2/empresas${query}`, options)
}

/**
 * `POST /v2/empresas` — cria uma empresa nova na Focus. Confirmado na doc
 * oficial (doc.focusnfe.com.br/reference/criar_empresa). Só deve ser
 * chamado quando `listFocusEmpresas(..., cnpj)` não retornou nenhuma
 * empresa com esse CNPJ — nunca cego, sempre depois de checar duplicata
 * (ver focusEmpresa.service.ts).
 */
export async function createFocusEmpresa(input: FocusEmpresaInput, options: FocusRequestOptions): Promise<FocusEmpresa> {
  return focusRequest<FocusEmpresa>('/v2/empresas', options, { method: 'POST', body: input })
}

/**
 * `PUT /v2/empresas/{id}` — atualiza uma empresa já cadastrada. `id` é o
 * identificador Focus (nunca o CNPJ) — confirmado na doc oficial
 * (doc.focusnfe.com.br/reference/atualizar_empresa). É o único ponto que
 * muda quando a empresa migra MEI → ME Simples Nacional: reenviar o mesmo
 * `id` com `regime_tributario` atualizado, sem criar empresa nova.
 */
export async function updateFocusEmpresa(focusEmpresaId: number, input: FocusEmpresaInput, options: FocusRequestOptions): Promise<FocusEmpresa> {
  return focusRequest<FocusEmpresa>(`/v2/empresas/${focusEmpresaId}`, options, { method: 'PUT', body: input })
}

/**
 * `GET /v2/nfe/{ref}` — consulta de status por ref. Usado tanto pra
 * polling manual (seção 9 do pedido da Fase 2B) quanto pelo próprio
 * `submitNfeHomologacao` antes de qualquer retransmissão, pra nunca
 * reemitir sem saber o resultado real da tentativa anterior.
 */
export async function consultFocusNfe(ref: string, options: FocusRequestOptions): Promise<FocusNfeConsultaResponse> {
  return focusRequest<FocusNfeConsultaResponse>(`/v2/nfe/${encodeURIComponent(ref)}`, options)
}

/**
 * `POST /v2/nfe?ref=<ref>` — emissão real de NF-e. Confirmado por leitura
 * direta do HTML bruto de doc.focusnfe.com.br/reference/emitir_nfe (via
 * `curl`, Fase Fiscal 2B): `method:"post"`, `path:"/nfe"`,
 * `ref` é **query parameter obrigatório** (não vai no corpo) —
 * `{"name":"ref","in":"query","required":true,"description":"Referência
 * única da NFe no seu sistema"}`.
 *
 * `ref` deve ser determinística (ver `buildProviderRef` em
 * `submitNfeHomologacao.ts`) — nunca gerada de novo a cada tentativa,
 * pra retry/timeout reaproveitarem a mesma referência (idempotência do
 * lado da Focus: reenviar o mesmo `ref` de um documento já em
 * processamento/autorizado retorna `already_processed`, não duplica).
 *
 * Só chamado pelo transmission service (`submitNfeHomologacao.ts`) —
 * nunca diretamente por uma rota, nunca automaticamente.
 */
export async function issueFocusNfe(ref: string, payload: unknown, options: FocusRequestOptions): Promise<FocusNfeConsultaResponse> {
  const query = `?ref=${encodeURIComponent(ref)}`
  return focusRequest<FocusNfeConsultaResponse>(`/v2/nfe${query}`, options, { method: 'POST', body: payload })
}

/**
 * `GET /v2/nfce/{referencia}` — consulta de status de NFC-e por ref. Fase
 * Fiscal 4E. Confirmado por leitura direta do OpenAPI real (`curl` +
 * `doc.focusnfe.com.br/reference/consultar_nfce.md`, JSON embutido no
 * markdown, não resumo de IA): `method:"get"`, `path:"/nfce/{referencia}"`
 * — path parameter, não query (diferente de `ref` na emissão, que É query
 * param — mesma distinção que já existe pra NF-e).
 */
export async function consultFocusNfce(ref: string, options: FocusRequestOptions): Promise<FocusNfceConsultaResponse> {
  return focusRequest<FocusNfceConsultaResponse>(`/v2/nfce/${encodeURIComponent(ref)}`, options)
}

/**
 * `POST /v2/nfce?ref=<ref>` — emissão real de NFC-e, SÍNCRONA (o resultado
 * — `autorizado`/`erro_autorizacao` — já vem nesta mesma resposta, nunca
 * precisa de polling posterior pra saber o resultado imediato; a consulta
 * continua útil só pra reconciliação após timeout/crash, mesmo padrão de
 * NF-e). Confirmado por leitura direta do OpenAPI real
 * (`doc.focusnfe.com.br/reference/emitir_nfce.md`): `method:"post"`,
 * `path:"/nfce"`, `ref` é **query parameter obrigatório** (mesma posição
 * que NF-e).
 *
 * `ref` continua determinística (`buildProviderRef(..., 'nfce')`) — nunca
 * gerada de novo a cada tentativa, mesma idempotência de `ref` do lado da
 * Focus já usada pra NF-e.
 *
 * Só chamado pelo transmission service (`submitNfceHomologacao.ts`) —
 * nunca diretamente por uma rota, nunca automaticamente.
 */
export async function issueFocusNfce(ref: string, payload: unknown, options: FocusRequestOptions): Promise<FocusNfceConsultaResponse> {
  const query = `?ref=${encodeURIComponent(ref)}`
  return focusRequest<FocusNfceConsultaResponse>(`/v2/nfce${query}`, options, { method: 'POST', body: payload })
}
