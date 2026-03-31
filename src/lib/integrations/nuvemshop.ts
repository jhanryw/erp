/**
 * Client da API Nuvemshop (Tiendanube)
 *
 * Envs necessárias:
 *   NUVEMSHOP_ACCESS_TOKEN  — token de acesso da loja
 *   NUVEMSHOP_STORE_ID      — ID numérico da loja
 *
 * Escopo atual: criação de produtos (sem update, sem deleção).
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseUrl() {
  const storeId = process.env.NUVEMSHOP_STORE_ID
  if (!storeId) throw new Error('NUVEMSHOP_STORE_ID não definida.')
  return `https://api.tiendanube.com/v1/${storeId}`
}

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'ERP Integration (suporte@seudominio.com)'

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
