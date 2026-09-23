/**
 * Service de Kits — criação de produto kit e edição de composição.
 *
 * Toda escrita passa por RPC transacional (migration 202609231300):
 *   rpc_create_kit_product  — produto + variações + composições, atômico
 *   rpc_add_kit_variations  — novas variações vendáveis num kit existente
 *   rpc_set_kit_components  — substitui a composição de uma variação
 *
 * company_id NUNCA vai no payload: as RPCs derivam a empresa de
 * users.company_id do usuário da sessão e reconferem todo id recebido.
 * A validação local (consolidateKitComponents) só antecipa mensagens
 * amigáveis — o banco continua sendo a barreira (RPC + triggers).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { consolidateKitComponents, type KitComponentLine } from '@/lib/inventory/stockRequirements'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface KitVariationInput {
  sku_variation: string
  price_override?: number | null
  wholesale_price_override?: number | null
  color_value_id?: number | null
  size_value_id?: number | null
  components: KitComponentLine[]
}

export interface CreateKitProductInput {
  name: string
  sku: string
  category_id: number
  brand_id?: number | null
  base_price: number
  wholesale_price?: number | null
  active?: boolean
  ano?: string | null
  ncm?: string | null
  cest?: string | null
  origem?: number | null
  unidade_med?: string | null
  variations: KitVariationInput[]
}

export interface CreatedKitVariation {
  id: number
  sku_variation: string
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

function rpcFailure(error: { code?: string; message: string }): ServiceOutcome<never> {
  if (error.code === 'P0001') return failure(error.message, 422)
  if (error.code === '23505') return failure('SKU já está em uso.', 409)
  return failure(error.message)
}

function normalizeVariations(variations: KitVariationInput[]): ServiceOutcome<KitVariationInput[]> {
  try {
    return success(variations.map((v) => ({
      ...v,
      sku_variation: v.sku_variation.trim(),
      components: consolidateKitComponents(v.components),
    })))
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Composição inválida.', 422)
  }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createKitProduct(
  userId: string,
  input: CreateKitProductInput,
): Promise<ServiceOutcome<{ product_id: number; variations: CreatedKitVariation[] }>> {
  const normalized = normalizeVariations(input.variations)
  if (!normalized.ok) return normalized

  const { variations: _ignored, ...product } = input
  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_create_kit_product', {
    p_user_id: userId,
    p_product: product,
    p_variations: normalized.data,
  }) as {
    data: { product_id: number; variations: CreatedKitVariation[] } | null
    error: { code?: string; message: string } | null
  }

  if (error) return rpcFailure(error)
  return success(data!)
}

export async function addKitVariations(
  userId: string,
  productId: number,
  variations: KitVariationInput[],
): Promise<ServiceOutcome<{ product_id: number; variations: CreatedKitVariation[] }>> {
  const normalized = normalizeVariations(variations)
  if (!normalized.ok) return normalized

  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_add_kit_variations', {
    p_user_id: userId,
    p_product_id: productId,
    p_variations: normalized.data,
  }) as {
    data: { product_id: number; variations: CreatedKitVariation[] } | null
    error: { code?: string; message: string } | null
  }

  if (error) return rpcFailure(error)
  return success(data!)
}

export async function setKitComponents(
  userId: string,
  kitVariationId: number,
  components: KitComponentLine[],
): Promise<ServiceOutcome<KitComponentLine[]>> {
  let consolidated: KitComponentLine[]
  try {
    consolidated = consolidateKitComponents(components, kitVariationId)
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Composição inválida.', 422)
  }

  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_set_kit_components', {
    p_user_id: userId,
    p_kit_variation_id: kitVariationId,
    p_components: consolidated,
  }) as { data: KitComponentLine[] | null; error: { code?: string; message: string } | null }

  if (error) return rpcFailure(error)
  return success(data ?? [])
}

/** Kits (produto + SKU) que usam esta variação como componente — p/ bloquear exclusão com mensagem clara. */
export async function listKitsUsingVariations(
  companyId: number,
  variationIds: number[],
): Promise<ServiceOutcome<Array<{ component_product_variation_id: number; kit_sku: string; kit_name: string }>>> {
  if (variationIds.length === 0) return success([])
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('product_kit_components')
    .select(`
      component_product_variation_id,
      kit:product_variations!product_kit_components_kit_product_variation_id_fkey (
        sku_variation, products!inner ( name )
      )
    `)
    .eq('company_id', companyId)
    .in('component_product_variation_id', variationIds) as {
      data: Array<{
        component_product_variation_id: number
        kit: { sku_variation: string; products: { name: string } } | null
      }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)
  return success((data ?? []).map((r) => ({
    component_product_variation_id: r.component_product_variation_id,
    kit_sku: r.kit?.sku_variation ?? '',
    kit_name: r.kit?.products?.name ?? '',
  })))
}
