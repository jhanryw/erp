/**
 * Client da API Nuvemshop (Tiendanube)
 *
 * Envs necessárias:
 *   NUVEMSHOP_ACCESS_TOKEN  — token de acesso da loja
 *   NUVEMSHOP_STORE_ID      — ID numérico da loja
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseUrl() {
  const storeId = process.env.NUVEMSHOP_STORE_ID
  if (!storeId) throw new Error('NUVEMSHOP_STORE_ID não definida.')
  return `https://api.tiendanube.com/v1/${storeId}`
}

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'erp-nuvemshop-integration (no-reply@local)'

function authHeaders(): Record<string, string> {
  const token = process.env.NUVEMSHOP_ACCESS_TOKEN
  if (!token) throw new Error('NUVEMSHOP_ACCESS_TOKEN não definida.')
  return {
    Authentication:  `bearer ${token}`,
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

export interface NuvemshopProductResponse {
  id:       number
  name:     Record<string, string>
  variants: Array<{ id: number; price: string; stock: number }>
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
}

// ─── createNuvemshopProduct ───────────────────────────────────────────────────

/**
 * Cria um produto na Nuvemshop com payload mínimo.
 * Retorna o produto criado com o ID externo.
 */
export async function createNuvemshopProduct(
  payload: NuvemshopProductPayload
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

  const res = await fetch(`${baseUrl()}/products`, {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Nuvemshop API ${res.status}: ${text}`)
  }

  return res.json() as Promise<NuvemshopProductResponse>
}

// ─── createNuvemshopProductFull ───────────────────────────────────────────────

/**
 * Cria um produto multi-variante na Nuvemshop com atributos, SKU e estoque por variante.
 * Retorna o produto criado incluindo todos os variants com seus IDs externos.
 */
export async function createNuvemshopProductFull(
  payload: NuvemshopProductFullPayload
): Promise<NuvemshopProductResponse> {
  const body: Record<string, unknown> = {
    name: { pt: payload.name },
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

  const res = await fetch(`${baseUrl()}/products`, {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Nuvemshop API ${res.status}: ${text}`)
  }

  return res.json() as Promise<NuvemshopProductResponse>
}

// ─── getMappedNuvemshopProduct ────────────────────────────────────────────────

/**
 * Retorna o mapping existente para um produto, ou null se ainda não enviado.
 */
export async function getMappedNuvemshopProduct(
  produtoId: number
): Promise<{ external_id: string } | null> {
  const admin = createAdminClient()

  const { data } = await (admin as any)
    .from('produto_map')
    .select('external_id')
    .eq('produto_id', produtoId)
    .eq('source', 'nuvemshop')
    .maybeSingle() as { data: { external_id: string } | null }

  return data ?? null
}

// ─── mapProductToNuvemshop ────────────────────────────────────────────────────

/**
 * Persiste o relacionamento produto_id ↔ external_id na tabela produto_map.
 */
export async function mapProductToNuvemshop(
  produtoId:  number,
  externalId: string
): Promise<void> {
  const admin = createAdminClient()

  const { error } = (await (admin as any)
    .from('produto_map')
    .insert({ produto_id: produtoId, external_id: externalId, source: 'nuvemshop' })
  ) as { error: { message: string } | null }

  if (error) throw new Error(`mapProductToNuvemshop: ${error.message}`)
}

// ─── mapVariantToNuvemshop ────────────────────────────────────────────────────

/**
 * Persiste o relacionamento variação interna ↔ variante externa na produto_map.
 * Usa ON CONFLICT DO NOTHING para ser idempotente.
 */
export async function mapVariantToNuvemshop(
  produtoId:          number,
  productVariationId: number,
  externalProductId:  string,
  externalVariantId:  string
): Promise<void> {
  const admin = createAdminClient()

  const { error } = (await (admin as any)
    .from('produto_map')
    .upsert(
      {
        produto_id:           produtoId,
        product_variation_id: productVariationId,
        external_id:          externalProductId,
        external_variant_id:  externalVariantId,
        source:               'nuvemshop',
      },
      { onConflict: 'source,external_variant_id', ignoreDuplicates: true }
    )
  ) as { error: { message: string } | null }

  if (error) throw new Error(`mapVariantToNuvemshop: ${error.message}`)
}

// ─── updateVariantStock ───────────────────────────────────────────────────────

/**
 * Sincroniza o estoque de uma variante na Nuvemshop via PUT.
 * Chamado após cada baixa de estoque no ERP para manter os canais alinhados.
 */
export async function updateVariantStock(
  externalProductId: string,
  externalVariantId: string,
  newQuantity:       number
): Promise<void> {
  const res = await fetch(
    `${baseUrl()}/products/${externalProductId}/variants/${externalVariantId}`,
    {
      method:  'PUT',
      headers: authHeaders(),
      body:    JSON.stringify({ stock: newQuantity }),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Nuvemshop updateVariantStock ${res.status}: ${text}`)
  }
}
