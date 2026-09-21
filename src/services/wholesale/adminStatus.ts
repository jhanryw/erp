/**
 * Status comercial do atacado para as telas ADMINISTRATIVAS do ERP
 * (lista de produtos, edição de produto).
 *
 * Não tem regra própria de preço/estoque/vendabilidade: cada variação é
 * avaliada por `evaluateWholesaleSellability` (a MESMA função do catálogo
 * público) e o estoque vem de `loadWholesaleStockByVariation`. Este módulo
 * só AGREGA os resultados em um status por produto e busca tudo em LOTE
 * (sem N+1 — o custo é constante em relação ao nº de produtos por lote).
 *
 * "Ativar no atacado" (wholesale_enabled) NÃO implica vendável: um produto
 * pode estar ativo no canal e ainda assim sem preço/estoque — o status
 * mostra exatamente isso.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllInChunks } from './queryBatching'
import { evaluateWholesaleSellability, loadWholesaleStockByVariation } from './sellability'

export type WholesaleAdminStatus =
  | 'inactive'       // products.active = false
  | 'disabled'       // wholesale_enabled = false
  | 'sellable'       // habilitado + ao menos 1 variação vendável
  | 'no_price'       // habilitado, nenhuma variação ativa tem preço de atacado válido
  | 'no_stock'       // habilitado, há preço, mas nenhuma variação tem estoque
  | 'no_variations'  // habilitado, sem nenhuma variação ativa

export type WholesaleVariationStatus = 'sellable' | 'no_price' | 'no_stock' | 'variation_inactive'

export interface AdminProductInput {
  id: number
  active: boolean
  wholesale_enabled: boolean
  wholesale_price: number | string | null
}

interface AdminVariationRow {
  id: number
  product_id: number
  sku_variation: string
  active: boolean
  price_override: number | null
  wholesale_price_override: number | null
}

export interface WholesaleVariationDetail {
  variationId: number
  sku: string
  active: boolean
  stock: number
  /** Preço de varejo efetivo (`price_override ?? base_price`) — só informativo no admin. */
  retailPrice: number | null
  /** Preço de atacado válido resolvido pela regra única; `null` = sem preço. */
  wholesalePrice: number | null
  /** Condição PRÓPRIA da variação (preço/estoque/ativa), independente do produto estar habilitado no canal. */
  status: WholesaleVariationStatus
}

export interface WholesaleProductSummary {
  status: WholesaleAdminStatus
  hasImage: boolean
  activeVariations: number
  sellableVariations: number
}

function variationOwnStatus(
  product: AdminProductInput,
  variation: { active: boolean; wholesale_price_override: number | null },
  stock: number,
): { status: WholesaleVariationStatus; price: number | null } {
  // Avalia com os flags do PRODUTO forçados a "ok" pra isolar a condição da
  // variação — o estado do canal aparece separado, no status do produto.
  const verdict = evaluateWholesaleSellability({
    product: { active: true, wholesale_enabled: true, wholesale_price: product.wholesale_price },
    variation,
    stock,
  })
  if (verdict.sellable) return { status: 'sellable', price: verdict.price }
  switch (verdict.reason) {
    case 'variation_inactive': return { status: 'variation_inactive', price: verdict.price }
    case 'no_wholesale_price': return { status: 'no_price', price: null }
    default: return { status: 'no_stock', price: verdict.price }
  }
}

/** Agrega o status do produto a partir das condições próprias das variações. Puro. */
export function summarizeWholesaleStatus(
  product: Pick<AdminProductInput, 'active' | 'wholesale_enabled'>,
  variationStatuses: WholesaleVariationStatus[],
): WholesaleAdminStatus {
  if (!product.active) return 'inactive'
  if (!product.wholesale_enabled) return 'disabled'

  const active = variationStatuses.filter((s) => s !== 'variation_inactive')
  if (active.length === 0) return 'no_variations'
  if (active.some((s) => s === 'sellable')) return 'sellable'
  if (active.every((s) => s === 'no_price')) return 'no_price'
  return 'no_stock'
}

/** Produtos (ids) que têm ao menos uma imagem utilizável pelo catálogo (primary/gallery de mídia ativa). Em lote. */
export async function loadProductsWithImage(admin: SupabaseClient, companyId: number, productIds: number[]): Promise<Set<number>> {
  const rows = await selectAllInChunks<{ entity_id: string }, string>(productIds.map(String), (chunk, from, to) =>
    (admin as any)
      .from('media_usages')
      .select('entity_id, media:media_id!inner(active)')
      .eq('entity_type', 'product')
      .eq('company_id', companyId)
      .in('entity_id', chunk)
      .in('role', ['primary', 'gallery'])
      .eq('media.active', true)
      .order('entity_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  return new Set(rows.map((r) => Number(r.entity_id)))
}

async function loadVariations(admin: SupabaseClient, productIds: number[]): Promise<AdminVariationRow[]> {
  return selectAllInChunks<AdminVariationRow, number>(productIds, (chunk, from, to) =>
    (admin as any)
      .from('product_variations')
      .select('id, product_id, sku_variation, active, price_override, wholesale_price_override')
      .in('product_id', chunk)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/** Resumo por produto para a LISTA — tudo em lote (variações, estoque e imagens de N produtos em poucas consultas). */
export async function loadWholesaleAdminSummaries(
  admin: SupabaseClient,
  companyId: number,
  products: AdminProductInput[],
): Promise<Map<number, WholesaleProductSummary>> {
  const result = new Map<number, WholesaleProductSummary>()
  if (products.length === 0) return result

  const productIds = products.map((p) => p.id)
  const variations = await loadVariations(admin, productIds)
  const [stockByVariation, withImage] = await Promise.all([
    loadWholesaleStockByVariation(admin, companyId, variations.map((v) => v.id)),
    loadProductsWithImage(admin, companyId, productIds),
  ])

  const byProduct = new Map<number, AdminVariationRow[]>()
  for (const v of variations) {
    const list = byProduct.get(v.product_id) ?? []
    list.push(v)
    byProduct.set(v.product_id, list)
  }

  for (const product of products) {
    const own = (byProduct.get(product.id) ?? []).map((v) => variationOwnStatus(product, v, stockByVariation[v.id] ?? 0).status)
    result.set(product.id, {
      status: summarizeWholesaleStatus(product, own),
      hasImage: withImage.has(product.id),
      activeVariations: own.filter((s) => s !== 'variation_inactive').length,
      sellableVariations: own.filter((s) => s === 'sellable').length,
    })
  }
  return result
}

/** Detalhe de UM produto para a tela de edição: status agregado + linha por variação (estoque, varejo, atacado, status). */
export async function loadWholesaleProductDetail(
  admin: SupabaseClient,
  companyId: number,
  product: AdminProductInput & { base_price: number },
): Promise<{ status: WholesaleAdminStatus; hasImage: boolean; variations: WholesaleVariationDetail[] }> {
  const variations = await loadVariations(admin, [product.id])
  const [stockByVariation, withImage] = await Promise.all([
    loadWholesaleStockByVariation(admin, companyId, variations.map((v) => v.id)),
    loadProductsWithImage(admin, companyId, [product.id]),
  ])

  const details: WholesaleVariationDetail[] = variations.map((v) => {
    const stock = stockByVariation[v.id] ?? 0
    const own = variationOwnStatus(product, v, stock)
    return {
      variationId: v.id,
      sku: v.sku_variation,
      active: v.active,
      stock,
      retailPrice: v.price_override ?? product.base_price,
      wholesalePrice: own.status === 'no_price' ? null : own.price,
      status: own.status,
    }
  })

  return {
    status: summarizeWholesaleStatus(product, details.map((d) => d.status)),
    hasImage: withImage.has(product.id),
    variations: details,
  }
}
