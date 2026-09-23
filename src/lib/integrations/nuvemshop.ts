/**
 * Client da API Nuvemshop (Tiendanube)
 *
 * Só HTTP — nada de banco aqui. Mappings ERP ↔ Nuvemshop ficam em
 * `services/nuvemshop/mappings.service.ts`.
 *
 * Credenciais: passadas explicitamente (resolvidas por empresa em
 * `services/nuvemshop/context.service.ts`). Sem credenciais, cai no legado
 * NUVEMSHOP_ACCESS_TOKEN / NUVEMSHOP_STORE_ID.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Credenciais de UMA loja. Toda chamada nova recebe as credenciais resolvidas
 * pela integração da empresa (`services/nuvemshop/context.service.ts`); o
 * fallback para env só existe para chamadores legados que ainda não passam.
 */
export interface NuvemshopCredentials {
  storeId:     string
  accessToken: string
}

/** Erro HTTP da API Nuvemshop — `status` permite tratar 404 como "não existe". */
export class NuvemshopApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, prefix = 'Nuvemshop API') {
    super(`${prefix} ${status}: ${body}`)
    this.name = 'NuvemshopApiError'
  }
}

export function isNuvemshopNotFound(err: unknown): boolean {
  return err instanceof NuvemshopApiError && err.status === 404
}

function resolveCredentials(creds?: NuvemshopCredentials): NuvemshopCredentials {
  if (creds) return creds
  const storeId = process.env.NUVEMSHOP_STORE_ID
  if (!storeId) throw new Error('NUVEMSHOP_STORE_ID não definida.')
  const accessToken = process.env.NUVEMSHOP_ACCESS_TOKEN
  if (!accessToken) throw new Error('NUVEMSHOP_ACCESS_TOKEN não definida.')
  return { storeId, accessToken }
}

function baseUrl(creds?: NuvemshopCredentials) {
  return `https://api.tiendanube.com/v1/${resolveCredentials(creds).storeId}`
}

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'erp-nuvemshop-integration (no-reply@local)'

function authHeaders(creds?: NuvemshopCredentials): Record<string, string> {
  return {
    Authentication:  `bearer ${resolveCredentials(creds).accessToken}`,
    'Content-Type':  'application/json',
    'User-Agent':    APP_AGENT,
  }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface NuvemshopProductPayload {
  name:         string
  description?: string
  price:        number
  stock?:       number
  images?:      string[]
}

export interface NuvemshopRemoteVariant {
  id:     number
  sku?:   string | null
  price?: string
  stock?: number | null
}

export interface NuvemshopProductResponse {
  id:       number
  name:     Record<string, string>
  variants: NuvemshopRemoteVariant[]
}

// ─── createNuvemshopProductFull types ─────────────────────────────────────────

export interface NuvemshopVariantInput {
  /** ERP internal variation id — used by caller to correlate mapping */
  internalVariationId: number
  price:               number
  stock:               number
  sku?:                string
  /** Ordered attribute values matching attributeNames order, e.g. ["Rosa", "M"] */
  attributeValues:     string[]
}

export interface NuvemshopProductFullPayload {
  name:            string
  description?:    string
  images?:         string[]
  /** Ordered attribute type names, e.g. ["Cor", "Tamanho"] */
  attributeNames:  string[]
  variants:        NuvemshopVariantInput[]
  /** Se false, cria o produto como oculto (rascunho). Default: false */
  published?:      boolean
}

// ─── createNuvemshopProduct ───────────────────────────────────────────────────

/**
 * Cria um produto na Nuvemshop com payload mínimo.
 * Retorna o produto criado com o ID externo.
 */
export async function createNuvemshopProduct(
  payload: NuvemshopProductPayload,
  creds?:  NuvemshopCredentials
): Promise<NuvemshopProductResponse> {
  const body: Record<string, unknown> = {
    name: { pt: payload.name },
    variants: [
      {
        price: payload.price.toFixed(2),
        ...(payload.stock != null ? { stock: payload.stock } : {}),
      },
    ],
  }

  if (payload.description) {
    body.description = { pt: payload.description }
  }

  if (payload.images && payload.images.length > 0) {
    body.images = payload.images.map((src) => ({ src }))
  }

  const res = await fetch(`${baseUrl(creds)}/products`, {
    method:  'POST',
    headers: authHeaders(creds),
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    throw new NuvemshopApiError(res.status, await res.text())
  }

  return res.json() as Promise<NuvemshopProductResponse>
}

// ─── createNuvemshopProductFull ───────────────────────────────────────────────

/**
 * Cria um produto multi-variante na Nuvemshop com atributos, SKU e estoque por variante.
 * Retorna o produto criado incluindo todos os variants com seus IDs externos.
 */
export async function createNuvemshopProductFull(
  payload: NuvemshopProductFullPayload,
  creds?:  NuvemshopCredentials
): Promise<NuvemshopProductResponse> {
  const body: Record<string, unknown> = {
    name:      { pt: payload.name },
    published: payload.published ?? false,
  }

  if (payload.description) {
    body.description = { pt: payload.description }
  }

  if (payload.images && payload.images.length > 0) {
    body.images = payload.images.map((src) => ({ src }))
  }

  // Attributes define the variant dimensions at product level (e.g. "Cor", "Tamanho")
  if (payload.attributeNames.length > 0) {
    body.attributes = payload.attributeNames.map((name) => ({ pt: name }))
  }

  body.variants = payload.variants.map((v) => ({
    price: v.price.toFixed(2),
    stock: v.stock,
    ...(v.sku ? { sku: v.sku } : {}),
    // values must align with the attributes order
    ...(v.attributeValues.length > 0
      ? { values: v.attributeValues.map((val) => ({ pt: val })) }
      : {}),
  }))

  const res = await fetch(`${baseUrl(creds)}/products`, {
    method:  'POST',
    headers: authHeaders(creds),
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    throw new NuvemshopApiError(res.status, await res.text())
  }

  return res.json() as Promise<NuvemshopProductResponse>
}

// ─── updateVariantStock ───────────────────────────────────────────────────────

/**
 * Sincroniza o estoque de uma variante na Nuvemshop via PUT.
 * Chamado após cada baixa de estoque no ERP para manter os canais alinhados.
 */
export async function updateVariantStock(
  externalProductId: string,
  externalVariantId: string,
  newQuantity:       number,
  creds?:            NuvemshopCredentials
): Promise<void> {
  const res = await fetch(
    `${baseUrl(creds)}/products/${externalProductId}/variants/${externalVariantId}`,
    {
      method:  'PUT',
      headers: authHeaders(creds),
      body:    JSON.stringify({ stock: newQuantity }),
    }
  )

  if (!res.ok) {
    throw new NuvemshopApiError(res.status, await res.text(), 'Nuvemshop updateVariantStock')
  }
}

// ─── Leitura de produtos remotos ──────────────────────────────────────────────

/** Produto remoto pelo ID. `null` quando a Nuvemshop responde 404 (excluído). */
export async function getNuvemshopProduct(
  externalProductId: string,
  creds?:            NuvemshopCredentials
): Promise<NuvemshopProductResponse | null> {
  const res = await fetch(`${baseUrl(creds)}/products/${encodeURIComponent(externalProductId)}`, {
    headers: authHeaders(creds),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new NuvemshopApiError(res.status, await res.text())
  return res.json() as Promise<NuvemshopProductResponse>
}

/** Produto remoto que contém uma variante com este SKU. `null` em 404. */
export async function getNuvemshopProductBySku(
  sku:    string,
  creds?: NuvemshopCredentials
): Promise<NuvemshopProductResponse | null> {
  const res = await fetch(`${baseUrl(creds)}/products/sku/${encodeURIComponent(sku)}`, {
    headers: authHeaders(creds),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new NuvemshopApiError(res.status, await res.text())
  return res.json() as Promise<NuvemshopProductResponse>
}

const LIST_PAGE_SIZE = 200
const LIST_MAX_PAGES = 500

/**
 * Todos os produtos da loja (id, nome, variantes com id/sku), paginado.
 * Lança em qualquer falha — quem reconcilia NÃO pode tratar lista parcial
 * como verdade (senão invalidaria mappings válidos).
 */
export async function listAllNuvemshopProducts(
  creds?: NuvemshopCredentials
): Promise<NuvemshopProductResponse[]> {
  const out: NuvemshopProductResponse[] = []
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const url = `${baseUrl(creds)}/products?page=${page}&per_page=${LIST_PAGE_SIZE}&fields=id,name,variants`
    const res = await fetch(url, { headers: authHeaders(creds) })
    // Nuvemshop responde 404 ao pedir uma página além da última.
    if (res.status === 404 && page > 1) break
    if (!res.ok) throw new NuvemshopApiError(res.status, await res.text())
    const items = await res.json() as NuvemshopProductResponse[]
    out.push(...items)
    if (items.length < LIST_PAGE_SIZE) break
    if (page === LIST_MAX_PAGES) throw new Error('listAllNuvemshopProducts: limite de páginas atingido.')
  }
  return out
}
