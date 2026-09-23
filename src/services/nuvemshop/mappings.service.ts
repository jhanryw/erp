/**
 * Mappings ERP ↔ Nuvemshop (`produto_map`, source='nuvemshop').
 *
 * ÚNICA camada que lê/grava/interpreta `produto_map` para a Nuvemshop.
 * Telas e rotas não consultam a tabela direto — perguntam aqui.
 *
 * Isolamento: `produto_map` não tem `company_id`. Toda função recebe
 * `companyId` e só devolve/altera linhas cujo `produto_id` pertence a um
 * produto dessa empresa (e, para variação, cuja variação pertence ao
 * produto). Nunca há lookup só por external_id/external_variant_id.
 *
 * Modelo de linhas (inalterado, sem migration):
 *   - linha de produto:  product_variation_id NULL, external_id = produto remoto
 *   - linha de variação: product_variation_id + external_variant_id
 *
 * Invalidação = remoção das linhas do vínculo morto (não existe coluna de
 * status). O conteúdo removido fica registrado em `nuvemshop_sync_logs`
 * (event_type 'mapping_invalidated', metadata.removed_rows).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'

const SOURCE = 'nuvemshop'
const PAGE = 1000
const ID_CHUNK = 200

export interface NuvemshopMappingRow {
  id:                   string | number
  produto_id:           number
  product_variation_id: number | null
  external_id:          string
  external_variant_id:  string | null
  last_stock_synced_at: string | null
}

const ROW_COLUMNS = 'id, produto_id, product_variation_id, external_id, external_variant_id, last_stock_synced_at'

export type NuvemshopPublicationState = 'not_published' | 'published' | 'inconsistent'

export interface NuvemshopProductMapping {
  productId:        number
  remoteProductId:  string
  productRow:       NuvemshopMappingRow | null
  variantRows:      NuvemshopMappingRow[]
}

export type InvalidationReason =
  | 'webhook_product_deleted'
  | 'reconcile_remote_product_missing'
  | 'reconcile_remote_variant_missing'
  | 'stock_push_404_product'
  | 'stock_push_404_variant'
  | 'publish_remote_product_missing'
  | 'publish_remote_variant_missing'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

type DbError = { message: string } | null

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbError }>): Promise<ServiceOutcome<T[]>> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) return failure(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return success(out)
  }
}

/** IDs de produtos da empresa (opcionalmente restritos a `productIds`, em lotes p/ URL curta). */
async function companyProductIds(companyId: number, productIds?: number[]): Promise<ServiceOutcome<Set<number>>> {
  const admin = createAdminClient()
  const out = new Set<number>()
  const chunks: (number[] | undefined)[] = []
  if (productIds) {
    const unique = [...new Set(productIds)]
    for (let i = 0; i < unique.length; i += ID_CHUNK) chunks.push(unique.slice(i, i + ID_CHUNK))
  } else {
    chunks.push(undefined)
  }
  for (const chunk of chunks) {
    const res = await fetchAll<{ id: number }>((from, to) => {
      let q = (admin as any).from('products').select('id').eq('company_id', companyId)
      if (chunk) q = q.in('id', chunk)
      return q.order('id', { ascending: true }).range(from, to)
    })
    if (!res.ok) return res
    for (const r of res.data) out.add(r.id)
  }
  return success(out)
}

async function productBelongsToCompany(companyId: number, productId: number): Promise<ServiceOutcome<boolean>> {
  const ids = await companyProductIds(companyId, [productId])
  if (!ids.ok) return ids
  return success(ids.data.has(productId))
}

/** Variação → produto dono, somente se o produto for da empresa. */
async function variationOwnerProductId(companyId: number, variationId: number): Promise<ServiceOutcome<number | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('product_variations')
    .select('id, product_id, products!inner(company_id)')
    .eq('id', variationId)
    .eq('products.company_id', companyId)
    .maybeSingle() as { data: { product_id: number } | null; error: DbError }
  if (error) return failure(error.message)
  return success(data?.product_id ?? null)
}

function groupByProduct(rows: NuvemshopMappingRow[]): Map<number, NuvemshopMappingRow[]> {
  const map = new Map<number, NuvemshopMappingRow[]>()
  for (const row of rows) {
    const list = map.get(row.produto_id) ?? []
    list.push(row)
    map.set(row.produto_id, list)
  }
  return map
}

function toProductMapping(productId: number, rows: NuvemshopMappingRow[]): NuvemshopProductMapping | null {
  if (rows.length === 0) return null
  const productRow = rows.find((r) => r.product_variation_id == null) ?? null
  const variantRows = rows.filter((r) => r.product_variation_id != null && r.external_variant_id != null)
  const remoteProductId = productRow?.external_id ?? variantRows[0]?.external_id
  if (!remoteProductId) return null
  return { productId, remoteProductId: String(remoteProductId), productRow, variantRows }
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

/** Todas as linhas Nuvemshop da empresa. */
export async function listNuvemshopMappingsForCompany(companyId: number): Promise<ServiceOutcome<NuvemshopMappingRow[]>> {
  const admin = createAdminClient()
  const rows = await fetchAll<NuvemshopMappingRow>((from, to) =>
    (admin as any).from('produto_map').select(ROW_COLUMNS).eq('source', SOURCE).order('produto_id', { ascending: true }).range(from, to))
  if (!rows.ok) return rows
  if (rows.data.length === 0) return success([])
  const owned = await companyProductIds(companyId, [...new Set(rows.data.map((r) => r.produto_id))])
  if (!owned.ok) return owned
  return success(rows.data.filter((r) => owned.data.has(r.produto_id)))
}

/** Mapping do produto (linha de produto + variações) ou null se não publicado. */
export async function getNuvemshopProductMapping(companyId: number, productId: number): Promise<ServiceOutcome<NuvemshopProductMapping | null>> {
  const owned = await productBelongsToCompany(companyId, productId)
  if (!owned.ok) return owned
  if (!owned.data) return success(null)

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('produto_map')
    .select(ROW_COLUMNS)
    .eq('source', SOURCE)
    .eq('produto_id', productId) as { data: NuvemshopMappingRow[] | null; error: DbError }
  if (error) return failure(error.message)
  return success(toProductMapping(productId, data ?? []))
}

/** Mapping de UMA variação (com external_variant_id) ou null. */
export async function getNuvemshopVariantMapping(companyId: number, variationId: number): Promise<ServiceOutcome<NuvemshopMappingRow | null>> {
  const owner = await variationOwnerProductId(companyId, variationId)
  if (!owner.ok) return owner
  if (owner.data == null) return success(null)

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('produto_map')
    .select(ROW_COLUMNS)
    .eq('source', SOURCE)
    .eq('product_variation_id', variationId)
    .maybeSingle() as { data: NuvemshopMappingRow | null; error: DbError }
  if (error) return failure(error.message)
  if (!data?.external_variant_id || data.produto_id !== owner.data) return success(null)
  return success(data)
}

/** Mappings da empresa que apontam para um produto remoto. */
export async function findNuvemshopMappingsByRemoteProduct(
  companyId: number,
  remoteProductId: string,
): Promise<ServiceOutcome<NuvemshopProductMapping[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('produto_map')
    .select(ROW_COLUMNS)
    .eq('source', SOURCE)
    .eq('external_id', String(remoteProductId)) as { data: NuvemshopMappingRow[] | null; error: DbError }
  if (error) return failure(error.message)
  const rows = data ?? []
  if (rows.length === 0) return success([])
  const owned = await companyProductIds(companyId, [...new Set(rows.map((r) => r.produto_id))])
  if (!owned.ok) return owned
  const out: NuvemshopProductMapping[] = []
  for (const [productId, list] of groupByProduct(rows.filter((r) => owned.data.has(r.produto_id)))) {
    const mapping = toProductMapping(productId, list)
    if (mapping) out.push(mapping)
  }
  return success(out)
}

/** Agrupa as linhas da empresa por produto. */
export function groupNuvemshopMappings(rows: NuvemshopMappingRow[]): Map<number, NuvemshopProductMapping> {
  const out = new Map<number, NuvemshopProductMapping>()
  for (const [productId, list] of groupByProduct(rows)) {
    const mapping = toProductMapping(productId, list)
    if (mapping) out.set(productId, mapping)
  }
  return out
}

/**
 * Estado de publicação — ÚNICA regra do sistema.
 *   not_published: nenhum vínculo.
 *   published:     linha de produto + TODA variação ativa com variante remota
 *                  do mesmo produto remoto.
 *   inconsistent:  qualquer outra combinação (falha parcial, variante
 *                  invalidada, variação nova no ERP, IDs remotos divergentes).
 * Estoque NÃO participa desta regra.
 */
export function computeNuvemshopPublicationState(
  mapping: NuvemshopProductMapping | null,
  activeVariationIds: number[],
): NuvemshopPublicationState {
  if (!mapping) return 'not_published'
  if (!mapping.productRow) return 'inconsistent'
  const byVariation = new Map(mapping.variantRows.map((r) => [r.product_variation_id, r]))
  if (activeVariationIds.length === 0) return 'inconsistent'
  for (const id of activeVariationIds) {
    const row = byVariation.get(id)
    if (!row || String(row.external_id) !== mapping.remoteProductId) return 'inconsistent'
  }
  return 'published'
}

export async function isNuvemshopProductPublished(
  companyId: number,
  productId: number,
  activeVariationIds: number[],
): Promise<ServiceOutcome<boolean>> {
  const mapping = await getNuvemshopProductMapping(companyId, productId)
  if (!mapping.ok) return mapping
  return success(computeNuvemshopPublicationState(mapping.data, activeVariationIds) === 'published')
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

export interface NuvemshopLogEntry {
  eventType:            string
  direction:            'erp_to_ns' | 'ns_to_erp'
  success?:             boolean
  productVariationId?:  number | null
  externalProductId?:   string | null
  externalVariantId?:   string | null
  errorMessage?:        string | null
  metadata?:            Record<string, unknown>
}

/** Log best-effort em nuvemshop_sync_logs — nunca derruba o fluxo. */
export async function logNuvemshopEvent(entry: NuvemshopLogEntry): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await (admin as any).from('nuvemshop_sync_logs').insert({
      event_type:           entry.eventType,
      direction:            entry.direction,
      product_variation_id: entry.productVariationId ?? null,
      external_product_id:  entry.externalProductId ?? null,
      external_variant_id:  entry.externalVariantId ?? null,
      success:              entry.success ?? true,
      error_message:        entry.errorMessage ?? null,
      metadata:             entry.metadata ?? null,
    }) as { error: DbError }
    if (error) console.error('[nuvemshop/mappings] Falha ao gravar nuvemshop_sync_logs', error.message)
  } catch (err) {
    console.error('[nuvemshop/mappings] Exceção ao gravar nuvemshop_sync_logs', err)
  }
}

async function deleteRows(rows: NuvemshopMappingRow[]): Promise<ServiceOutcome<void>> {
  if (rows.length === 0) return success(undefined)
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('produto_map')
    .delete()
    .eq('source', SOURCE)
    .in('id', rows.map((r) => r.id)) as { error: DbError }
  if (error) return failure(error.message)
  return success(undefined)
}

/**
 * Invalida TODO o vínculo de um produto — somente se ele ainda aponta para
 * `expectedRemoteProductId`. Isso impede que um product/deleted atrasado do
 * produto remoto ANTIGO apague o vínculo novo criado numa republicação.
 * Idempotente: sem linhas correspondentes → { removed: 0 }.
 */
export async function invalidateNuvemshopProductMapping(
  companyId: number,
  productId: number,
  opts: { expectedRemoteProductId: string; reason: InvalidationReason; metadata?: Record<string, unknown> },
): Promise<ServiceOutcome<{ removed: number }>> {
  const owned = await productBelongsToCompany(companyId, productId)
  if (!owned.ok) return owned
  if (!owned.data) return success({ removed: 0 })

  const admin = createAdminClient()
  const { data: rows, error } = await (admin as any)
    .from('produto_map')
    .select(ROW_COLUMNS)
    .eq('source', SOURCE)
    .eq('produto_id', productId) as { data: NuvemshopMappingRow[] | null; error: DbError }
  if (error) return failure(error.message)

  const expected = String(opts.expectedRemoteProductId)
  const target = (rows ?? []).filter((r) => String(r.external_id) === expected)
  const del = await deleteRows(target)
  if (!del.ok) return del

  if (target.length > 0) {
    await logNuvemshopEvent({
      eventType:         'mapping_invalidated',
      direction:         'ns_to_erp',
      externalProductId: expected,
      metadata:          { company_id: companyId, produto_id: productId, reason: opts.reason, scope: 'product', removed_rows: target, ...opts.metadata },
    })
  }
  return success({ removed: target.length })
}

/** Invalida o vínculo de UMA variação (somente se ainda aponta para a variante esperada). */
export async function invalidateNuvemshopVariantMapping(
  companyId: number,
  variationId: number,
  opts: { expectedRemoteVariantId: string; reason: InvalidationReason; metadata?: Record<string, unknown> },
): Promise<ServiceOutcome<{ removed: number }>> {
  const row = await getNuvemshopVariantMapping(companyId, variationId)
  if (!row.ok) return row
  if (!row.data || String(row.data.external_variant_id) !== String(opts.expectedRemoteVariantId)) return success({ removed: 0 })

  const del = await deleteRows([row.data])
  if (!del.ok) return del
  await logNuvemshopEvent({
    eventType:          'mapping_invalidated',
    direction:          'ns_to_erp',
    productVariationId: variationId,
    externalProductId:  row.data.external_id,
    externalVariantId:  row.data.external_variant_id,
    metadata:           { company_id: companyId, produto_id: row.data.produto_id, reason: opts.reason, scope: 'variant', removed_rows: [row.data], ...opts.metadata },
  })
  return success({ removed: 1 })
}

/** Grava/atualiza a linha de produto (idempotente). */
export async function saveNuvemshopProductMapping(
  companyId: number,
  productId: number,
  remoteProductId: string,
): Promise<ServiceOutcome<void>> {
  const owned = await productBelongsToCompany(companyId, productId)
  if (!owned.ok) return owned
  if (!owned.data) return failure('Produto não pertence à empresa.', 404)

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await (admin as any)
    .from('produto_map')
    .select('id')
    .eq('source', SOURCE)
    .eq('produto_id', productId)
    .is('product_variation_id', null)
    .maybeSingle() as { data: { id: string | number } | null; error: DbError }
  if (selErr) return failure(selErr.message)

  const { error } = existing
    ? await (admin as any).from('produto_map').update({ external_id: String(remoteProductId) }).eq('id', existing.id) as { error: DbError }
    : await (admin as any).from('produto_map').insert({
        produto_id: productId, external_id: String(remoteProductId), source: SOURCE, product_variation_id: null,
      }) as { error: DbError }
  if (error) return failure(error.message)
  return success(undefined)
}

/** Grava/atualiza a linha de UMA variação (idempotente). */
export async function saveNuvemshopVariantMapping(
  companyId: number,
  productId: number,
  variationId: number,
  remoteProductId: string,
  remoteVariantId: string,
): Promise<ServiceOutcome<void>> {
  const owner = await variationOwnerProductId(companyId, variationId)
  if (!owner.ok) return owner
  if (owner.data !== productId) return failure('Variação não pertence ao produto/empresa.', 404)

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await (admin as any)
    .from('produto_map')
    .select('id')
    .eq('source', SOURCE)
    .eq('product_variation_id', variationId)
    .maybeSingle() as { data: { id: string | number } | null; error: DbError }
  if (selErr) return failure(selErr.message)

  const values = {
    produto_id:           productId,
    external_id:          String(remoteProductId),
    external_variant_id:  String(remoteVariantId),
    last_stock_synced_at: null,
  }
  const { error } = existing
    ? await (admin as any).from('produto_map').update(values).eq('id', existing.id) as { error: DbError }
    : await (admin as any).from('produto_map').insert({ ...values, product_variation_id: variationId, source: SOURCE }) as { error: DbError }
  if (error) return failure(error.message)
  return success(undefined)
}
