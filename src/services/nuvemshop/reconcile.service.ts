/**
 * Reconciliação ERP ↔ Nuvemshop (produtos).
 *
 * Proteção contra webhook perdido/falho: compara os mappings da empresa com
 * os produtos que existem de fato na loja.
 *
 *   remoto existe                     → mantém
 *   remoto não existe (confirmado     → invalida vínculo do produto
 *     por GET individual = 404)
 *   variante mapeada não existe       → invalida só aquela variante, reporta
 *   remoto sem vínculo local          → só reporta (nunca importa)
 *
 * Nunca exclui nada na Nuvemshop e nunca cria nada. Falha ao listar a loja
 * aborta sem nenhuma alteração (lista parcial não é verdade).
 */

import {
  getNuvemshopProduct,
  listAllNuvemshopProducts,
  type NuvemshopProductResponse,
} from '@/lib/integrations/nuvemshop'
import type { NuvemshopContext } from './context.service'
import {
  groupNuvemshopMappings,
  invalidateNuvemshopProductMapping,
  invalidateNuvemshopVariantMapping,
  listNuvemshopMappingsForCompany,
  logNuvemshopEvent,
  type NuvemshopProductMapping,
} from './mappings.service'
import type { ServiceOutcome } from '../produtos.service'

export interface ReconcileSummary {
  dry_run:                    boolean
  checked:                    number
  valid:                      number
  remote_deleted:             number
  inconsistent_variants:      number
  remote_unlinked:            number
  errors:                     number
  details: {
    remote_deleted:        Array<{ product_id: number; remote_product_id: string }>
    inconsistent_variants: Array<{ product_id: number; product_variation_id: number; remote_product_id: string; remote_variant_id: string }>
    remote_unlinked:       Array<{ remote_product_id: string; name: string; skus: string[] }>
    errors:                Array<{ product_id?: number; remote_product_id?: string; error: string }>
  }
}

const UNLINKED_REPORT_LIMIT = 200

function productName(p: NuvemshopProductResponse): string {
  const n = p.name as unknown
  if (typeof n === 'string') return n
  const rec = (n ?? {}) as Record<string, string>
  return rec.pt ?? rec.es ?? rec.en ?? Object.values(rec)[0] ?? ''
}

// ─── Diff puro ────────────────────────────────────────────────────────────────

export interface MappingTarget {
  productId:       number
  remoteProductId: string
  variantRows:     Array<{ variationId: number; remoteVariantId: string }>
}

export interface ReconcileDiff {
  valid:            MappingTarget[]
  missingRemote:    MappingTarget[]
  missingVariants:  Array<{ productId: number; variationId: number; remoteProductId: string; remoteVariantId: string }>
  unlinkedRemote:   NuvemshopProductResponse[]
}

/** Um alvo por (produto ERP, produto remoto) — cobre vínculos legados divergentes. */
export function mappingTargets(mappings: Iterable<NuvemshopProductMapping>): MappingTarget[] {
  const out: MappingTarget[] = []
  for (const m of mappings) {
    const byRemote = new Map<string, MappingTarget>()
    const ensure = (remoteId: string) => {
      let t = byRemote.get(remoteId)
      if (!t) { t = { productId: m.productId, remoteProductId: remoteId, variantRows: [] }; byRemote.set(remoteId, t) }
      return t
    }
    if (m.productRow) ensure(String(m.productRow.external_id))
    for (const r of m.variantRows) {
      ensure(String(r.external_id)).variantRows.push({ variationId: r.product_variation_id!, remoteVariantId: String(r.external_variant_id) })
    }
    out.push(...byRemote.values())
  }
  return out
}

export function diffNuvemshopMappings(targets: MappingTarget[], remote: NuvemshopProductResponse[]): ReconcileDiff {
  const remoteById = new Map(remote.map((p) => [String(p.id), p]))
  const linked = new Set(targets.map((t) => t.remoteProductId))
  const diff: ReconcileDiff = { valid: [], missingRemote: [], missingVariants: [], unlinkedRemote: [] }

  for (const t of targets) {
    const rp = remoteById.get(t.remoteProductId)
    if (!rp) { diff.missingRemote.push(t); continue }
    diff.valid.push(t)
    const variantIds = new Set((rp.variants ?? []).map((v) => String(v.id)))
    for (const v of t.variantRows) {
      if (!variantIds.has(v.remoteVariantId)) diff.missingVariants.push({ productId: t.productId, variationId: v.variationId, remoteProductId: t.remoteProductId, remoteVariantId: v.remoteVariantId })
    }
  }
  for (const rp of remote) if (!linked.has(String(rp.id))) diff.unlinkedRemote.push(rp)
  return diff
}

// ─── Orquestração ─────────────────────────────────────────────────────────────

export async function reconcileNuvemshopProducts(
  ctx: NuvemshopContext,
  opts: { dryRun?: boolean } = {},
): Promise<ServiceOutcome<ReconcileSummary>> {
  const dryRun = opts.dryRun === true

  const rows = await listNuvemshopMappingsForCompany(ctx.companyId)
  if (!rows.ok) return rows
  const targets = mappingTargets(groupNuvemshopMappings(rows.data).values())

  let remote: NuvemshopProductResponse[]
  try {
    remote = await listAllNuvemshopProducts(ctx.credentials)
  } catch (err) {
    return { ok: false, error: `Falha ao listar produtos da Nuvemshop — nenhuma alteração feita: ${err instanceof Error ? err.message : String(err)}`, status: 502 }
  }

  const diff = diffNuvemshopMappings(targets, remote)
  const summary: ReconcileSummary = {
    dry_run: dryRun, checked: targets.length, valid: diff.valid.length, remote_deleted: 0, inconsistent_variants: 0,
    remote_unlinked: diff.unlinkedRemote.length, errors: 0,
    details: { remote_deleted: [], inconsistent_variants: [], remote_unlinked: [], errors: [] },
  }
  const addError = (e: { product_id?: number; remote_product_id?: string; error: string }) => { summary.errors++; summary.details.errors.push(e) }

  // Ausente da listagem → confirma individualmente antes de invalidar.
  for (const t of diff.missingRemote) {
    let confirmed: NuvemshopProductResponse | null
    try {
      confirmed = await getNuvemshopProduct(t.remoteProductId, ctx.credentials)
    } catch (err) {
      addError({ product_id: t.productId, remote_product_id: t.remoteProductId, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (confirmed) {
      // Listagem inconsistente com GET: trata como válido e confere variantes.
      summary.valid++
      const variantIds = new Set((confirmed.variants ?? []).map((v) => String(v.id)))
      for (const v of t.variantRows) {
        if (!variantIds.has(v.remoteVariantId)) diff.missingVariants.push({ productId: t.productId, variationId: v.variationId, remoteProductId: t.remoteProductId, remoteVariantId: v.remoteVariantId })
      }
      continue
    }
    if (!dryRun) {
      const inv = await invalidateNuvemshopProductMapping(ctx.companyId, t.productId, { expectedRemoteProductId: t.remoteProductId, reason: 'reconcile_remote_product_missing' })
      if (!inv.ok) { addError({ product_id: t.productId, remote_product_id: t.remoteProductId, error: inv.error }); continue }
    }
    summary.remote_deleted++
    summary.details.remote_deleted.push({ product_id: t.productId, remote_product_id: t.remoteProductId })
  }

  for (const v of diff.missingVariants) {
    if (!dryRun) {
      const inv = await invalidateNuvemshopVariantMapping(ctx.companyId, v.variationId, { expectedRemoteVariantId: v.remoteVariantId, reason: 'reconcile_remote_variant_missing' })
      if (!inv.ok) { addError({ product_id: v.productId, remote_product_id: v.remoteProductId, error: inv.error }); continue }
    }
    summary.inconsistent_variants++
    summary.details.inconsistent_variants.push({ product_id: v.productId, product_variation_id: v.variationId, remote_product_id: v.remoteProductId, remote_variant_id: v.remoteVariantId })
  }

  summary.details.remote_unlinked = diff.unlinkedRemote.slice(0, UNLINKED_REPORT_LIMIT).map((p) => ({
    remote_product_id: String(p.id),
    name:              productName(p),
    skus:              (p.variants ?? []).map((v) => v.sku ?? '').filter(Boolean),
  }))

  await logNuvemshopEvent({
    eventType: 'products_reconcile', direction: 'ns_to_erp', success: summary.errors === 0,
    metadata: {
      company_id: ctx.companyId, store_id: ctx.storeId, dry_run: dryRun, checked: summary.checked, valid: summary.valid,
      remote_deleted: summary.details.remote_deleted, inconsistent_variants: summary.details.inconsistent_variants,
      remote_unlinked: summary.remote_unlinked, errors: summary.details.errors,
    },
  })

  return { ok: true, data: summary }
}
