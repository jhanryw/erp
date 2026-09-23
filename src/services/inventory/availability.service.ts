/**
 * Service de Disponibilidade Vendável — camada CENTRAL que responde "quanto
 * desta variação dá para vender?" para produto normal e kit, sem que quem
 * pergunta (PDV, telas de estoque, integrações/Marketplace Hub) conheça a
 * fórmula do kit.
 *
 *   getSellableQuantity(company, variação, modo)       → número
 *   getVariationAvailability(company, variações, modo) → quantidade + manual + vendável
 *   resolveStockRequirementsForItems(company, itens)   → consumo físico agregado
 *   getAffectedSellableVariationIds(company, variações) → quem precisa ser
 *     republicado quando estas variações mudam (ela própria, componentes e
 *     kits dependentes)
 *
 * A AUTORIDADE é o banco: `rpc_get_variation_availability` →
 * `fn_variation_sellable_quantity` (mesma função usada pelo cache
 * `variation_availability` e com a mesma regra de locais que
 * `rpc_create_sale` usa para baixar). Na venda, a decisão final é sempre da
 * RPC, sob lock — esta camada é para leitura/exibição/integração.
 *
 * Modos (StockMode) — mesmos de rpc_create_sale:
 *   'main_store'      → só o Estoque Loja (PDV)
 *   'online_priority' → soma dos locais ativos (site/canais)
 *
 * Multi-tenant: company_id SEMPRE vem da sessão/servidor. Variação de outra
 * empresa simplesmente não aparece no resultado (nunca vaza saldo).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'
import {
  resolveStockRequirements,
  computeKitAvailability,
  componentKitCapacity,
  computeKitUnitCost,
  findBottleneck,
  type KitComponentLine,
  type StockRequirement,
  type StockRequirementItem,
} from '@/lib/inventory/stockRequirements'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type StockMode = 'main_store' | 'online_priority'
export type ProductKind = 'standard' | 'kit'

export interface VariationAvailability {
  product_variation_id: number
  product_id: number
  product_kind: ProductKind
  /** products.active && product_variations.active — decisão MANUAL do usuário. */
  manual_enabled: boolean
  /** Quantidade vendável derivada (kit) ou física (normal) no modo pedido. */
  sellable_quantity: number
  /** sellable_quantity > 0 */
  inventory_available: boolean
  /** manual_enabled && inventory_available */
  is_sellable: boolean
}

export interface KitComponentDetail {
  component_product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  cor: string | null
  tamanho: string | null
  quantity: number
  unit_cost: number
  available_main_store: number
  available_online: number
  capacity_main_store: number
  capacity_online: number
}

export interface KitCompositionDetail {
  kit_product_variation_id: number
  components: KitComponentDetail[]
  unit_cost: number
  available_main_store: number
  available_online: number
  /** SKU do componente que limita a disponibilidade online (null se vazio). */
  bottleneck_sku: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
}

// ─── Disponibilidade ──────────────────────────────────────────────────────────

export async function getVariationAvailability(
  companyId: number,
  variationIds: number[],
  stockMode: StockMode = 'online_priority',
): Promise<ServiceOutcome<Map<number, VariationAvailability>>> {
  const ids = uniqueIds(variationIds)
  const result = new Map<number, VariationAvailability>()
  if (ids.length === 0) return success(result)

  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_get_variation_availability', {
    p_company_id: companyId,
    p_variation_ids: ids,
    p_stock_mode: stockMode,
  }) as { data: VariationAvailability[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  for (const row of data ?? []) result.set(row.product_variation_id, row)
  return success(result)
}

/** Quantidade vendável de UMA variação (0 se não existir / outra empresa). */
export async function getSellableQuantity(
  companyId: number,
  variationId: number,
  stockMode: StockMode = 'online_priority',
): Promise<ServiceOutcome<number>> {
  const res = await getVariationAvailability(companyId, [variationId], stockMode)
  if (!res.ok) return res
  return success(res.data.get(variationId)?.sellable_quantity ?? 0)
}

// ─── Composição ───────────────────────────────────────────────────────────────

/** Mapa kit → linhas de composição, só dos kits da empresa informada. */
export async function loadKitCompositions(
  companyId: number,
  kitVariationIds: number[],
): Promise<ServiceOutcome<Map<number, KitComponentLine[]>>> {
  const ids = uniqueIds(kitVariationIds)
  const map = new Map<number, KitComponentLine[]>()
  if (ids.length === 0) return success(map)

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('product_kit_components')
    .select('kit_product_variation_id, component_product_variation_id, quantity')
    .eq('company_id', companyId)
    .in('kit_product_variation_id', ids)
    .order('component_product_variation_id') as {
      data: Array<{ kit_product_variation_id: number; component_product_variation_id: number; quantity: number }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)
  for (const row of data ?? []) {
    const list = map.get(row.kit_product_variation_id) ?? []
    list.push({ component_product_variation_id: row.component_product_variation_id, quantity: row.quantity })
    map.set(row.kit_product_variation_id, list)
  }
  return success(map)
}

/** Ids (da empresa) que são variações de kit. */
export async function findKitVariationIds(companyId: number, variationIds: number[]): Promise<ServiceOutcome<Set<number>>> {
  const ids = uniqueIds(variationIds)
  if (ids.length === 0) return success(new Set())

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('product_variations')
    .select('id, products!inner(company_id, product_kind)')
    .in('id', ids)
    .eq('products.company_id', companyId)
    .eq('products.product_kind', 'kit') as { data: Array<{ id: number }> | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(new Set((data ?? []).map((r) => r.id)))
}

/**
 * Consumo físico agregado de um conjunto de itens (kits expandidos).
 * Kit sem composição → erro (422), igual à RPC.
 */
export async function resolveStockRequirementsForItems(
  companyId: number,
  items: StockRequirementItem[],
): Promise<ServiceOutcome<StockRequirement[]>> {
  const kits = await findKitVariationIds(companyId, items.map((i) => i.product_variation_id))
  if (!kits.ok) return kits
  const compositions = await loadKitCompositions(companyId, [...kits.data])
  if (!compositions.ok) return compositions
  for (const kitId of kits.data) {
    if (!compositions.data.has(kitId)) compositions.data.set(kitId, [])
  }
  try {
    return success(resolveStockRequirements(items, compositions.data))
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Composição de kit inválida.', 422)
  }
}

/**
 * Detalhe da composição com estoque e capacidade por componente — o que a
 * tela de kit mostra ("Estoque disponível: 14 · Permite: 7 kits").
 */
export async function getKitCompositionDetails(
  companyId: number,
  kitVariationIds: number[],
): Promise<ServiceOutcome<Map<number, KitCompositionDetail>>> {
  const ids = uniqueIds(kitVariationIds)
  const out = new Map<number, KitCompositionDetail>()
  if (ids.length === 0) return success(out)

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('product_kit_components')
    .select(`
      kit_product_variation_id,
      component_product_variation_id,
      quantity,
      component:product_variations!product_kit_components_component_product_variation_id_fkey (
        id, sku_variation, cost_override, product_id,
        products!inner ( id, name, base_cost, company_id ),
        product_variation_attributes (
          variation_types:variation_type_id ( slug ),
          variation_values:variation_value_id ( value )
        )
      )
    `)
    .eq('company_id', companyId)
    .in('kit_product_variation_id', ids)
    .order('component_product_variation_id') as {
      data: Array<{
        kit_product_variation_id: number
        component_product_variation_id: number
        quantity: number
        component: {
          id: number
          sku_variation: string
          cost_override: number | null
          product_id: number
          products: { id: number; name: string; base_cost: number; company_id: number }
          product_variation_attributes: Array<{
            variation_types: { slug: string } | null
            variation_values: { value: string } | null
          }>
        } | null
      }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)

  const rows = (data ?? []).filter((r) => r.component && r.component.products.company_id === companyId)
  const componentIds = uniqueIds(rows.map((r) => r.component_product_variation_id))

  const [mainRes, onlineRes] = await Promise.all([
    getVariationAvailability(companyId, componentIds, 'main_store'),
    getVariationAvailability(companyId, componentIds, 'online_priority'),
  ])
  if (!mainRes.ok) return mainRes
  if (!onlineRes.ok) return onlineRes

  for (const kitId of ids) {
    const components: KitComponentDetail[] = rows
      .filter((r) => r.kit_product_variation_id === kitId)
      .map((r) => {
        const comp = r.component!
        const attrs = comp.product_variation_attributes ?? []
        const availableMain = mainRes.data.get(comp.id)?.sellable_quantity ?? 0
        const availableOnline = onlineRes.data.get(comp.id)?.sellable_quantity ?? 0
        return {
          component_product_variation_id: comp.id,
          product_id: comp.product_id,
          product_name: comp.products.name,
          sku_variation: comp.sku_variation,
          cor: attrs.find((a) => a.variation_types?.slug === 'cor')?.variation_values?.value ?? null,
          tamanho: attrs.find((a) => a.variation_types?.slug === 'tamanho')?.variation_values?.value ?? null,
          quantity: r.quantity,
          unit_cost: Number(comp.cost_override ?? comp.products.base_cost ?? 0),
          available_main_store: availableMain,
          available_online: availableOnline,
          capacity_main_store: componentKitCapacity(availableMain, r.quantity),
          capacity_online: componentKitCapacity(availableOnline, r.quantity),
        }
      })

    const bottleneck = findBottleneck(components.map((c) => ({ ...c, available: c.available_online })))
    out.set(kitId, {
      kit_product_variation_id: kitId,
      components,
      unit_cost: computeKitUnitCost(components),
      available_main_store: computeKitAvailability(components.map((c) => ({ quantity: c.quantity, available: c.available_main_store }))),
      available_online: computeKitAvailability(components.map((c) => ({ quantity: c.quantity, available: c.available_online }))),
      bottleneck_sku: bottleneck?.sku_variation ?? null,
    })
  }

  return success(out)
}

/** Custo autoritativo (cost_override ?? base_cost dos componentes) por kit. */
export async function getKitUnitCosts(
  companyId: number,
  kitVariationIds: number[],
): Promise<ServiceOutcome<Map<number, number>>> {
  const details = await getKitCompositionDetails(companyId, kitVariationIds)
  if (!details.ok) return details
  const costs = new Map<number, number>()
  for (const [kitId, detail] of details.data) costs.set(kitId, detail.unit_cost)
  return success(costs)
}

export interface KitStockAnnotation {
  available_main_store: number
  available_online: number
  manual_enabled: boolean
}

/**
 * Para telas de estoque: dentre as variações listadas, quais são kits e qual
 * a disponibilidade DERIVADA de cada uma (kit nunca tem saldo por local).
 */
export async function getKitStockAnnotations(
  companyId: number,
  variationIds: number[],
): Promise<ServiceOutcome<Map<number, KitStockAnnotation>>> {
  const out = new Map<number, KitStockAnnotation>()
  const kits = await findKitVariationIds(companyId, variationIds)
  if (!kits.ok) return kits
  if (kits.data.size === 0) return success(out)

  const [main, online] = await Promise.all([
    getVariationAvailability(companyId, [...kits.data], 'main_store'),
    getVariationAvailability(companyId, [...kits.data], 'online_priority'),
  ])
  if (!main.ok) return main
  if (!online.ok) return online

  for (const id of kits.data) {
    out.set(id, {
      available_main_store: main.data.get(id)?.sellable_quantity ?? 0,
      available_online: online.data.get(id)?.sellable_quantity ?? 0,
      manual_enabled: online.data.get(id)?.manual_enabled ?? false,
    })
  }
  return success(out)
}

// ─── Propagação ──────────────────────────────────────────────────────────────

/**
 * Quando estas variações mudam de estoque (ou são vendidas), quais variações
 * VENDÁVEIS precisam ter a disponibilidade republicada?
 *   - a própria variação;
 *   - se for kit, seus componentes (foram eles que mudaram de saldo);
 *   - todo kit que usa qualquer uma das variações físicas envolvidas.
 * Genérico — nenhum canal precisa saber o que é kit.
 */
export async function getAffectedSellableVariationIds(
  companyId: number,
  variationIds: number[],
): Promise<ServiceOutcome<number[]>> {
  const ids = uniqueIds(variationIds)
  if (ids.length === 0) return success([])

  const kits = await findKitVariationIds(companyId, ids)
  if (!kits.ok) return kits
  const compositions = await loadKitCompositions(companyId, [...kits.data])
  if (!compositions.ok) return compositions

  const physical = new Set<number>(ids.filter((id) => !kits.data.has(id)))
  for (const lines of compositions.data.values()) {
    for (const line of lines) physical.add(line.component_product_variation_id)
  }

  const affected = new Set<number>([...ids, ...physical])
  if (physical.size > 0) {
    const admin = createAdminClient()
    const { data, error } = await (admin as any)
      .from('product_kit_components')
      .select('kit_product_variation_id')
      .eq('company_id', companyId)
      .in('component_product_variation_id', [...physical]) as {
        data: Array<{ kit_product_variation_id: number }> | null
        error: { message: string } | null
      }
    if (error) return failure(error.message)
    for (const row of data ?? []) affected.add(row.kit_product_variation_id)
  }

  return success([...affected].sort((a, b) => a - b))
}

// ─── Fila de disponibilidade ──────────────────────────────────────────────────

export interface AvailabilityProcessResult {
  claimed: number
  variations: number
  changed: number
  became_sellable: number
  became_unavailable: number
}

/**
 * Consome `stock_availability_changes` (via RPC, SKIP LOCKED, idempotente)
 * e atualiza o cache derivado `variation_availability`. Chamado pelo job
 * `/api/jobs/stock-availability/run`. Futuro Marketplace Hub: é aqui que as
 * deliveries por canal nascem a partir das transições.
 */
export async function processStockAvailabilityChanges(
  limit: number,
  workerId: string,
): Promise<ServiceOutcome<AvailabilityProcessResult>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_process_stock_availability_changes', {
    p_limit: limit,
    p_worker_id: workerId,
  }) as { data: AvailabilityProcessResult | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? { claimed: 0, variations: 0, changed: 0, became_sellable: 0, became_unavailable: 0 })
}
