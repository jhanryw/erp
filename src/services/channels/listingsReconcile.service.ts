/**
 * Reconciliação PERIÓDICA canal → Qarvon dos anúncios vivos (active/paused
 * com id externo). SOMENTE LEITURA no canal: nenhum preço, estoque, status
 * ou conteúdo é enviado. Atualiza no Qarvon o estado observado:
 *
 *   - preço: mesma regra de syncListing (externalPriceTransition) — preço
 *     alterado no canal vira preço próprio externo da oferta; o preço-base do
 *     produto nunca muda;
 *   - status: reflete o do canal (encerrado, pausado pelo vendedor,
 *     reativado); moderação/revisão fica visível, sem "corrigir" nada;
 *   - quantidade observada, ids externos, tipo de anúncio, motivo da pausa;
 *   - divergências em metadata.reconcile (UI) e erro individual em
 *     last_reconcile_error (um anúncio com erro não interrompe os outros).
 *
 * Lote: rpc_claim_channel_listings_reconcile (SKIP LOCKED) → agrupa por
 * empresa → 1 leitura em lote no canal a cada 20 anúncios (multiget) →
 * grava com trava otimista em updated_at (se um sync/edição mudou a linha
 * no meio, esta rodada não sobrescreve; a próxima reconcilia).
 *
 * Diferente de reconcileListing (vínculos SEM id externo, busca por SKU):
 * aqui o vínculo já existe e só é lido pelo id.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logMercadoLivre } from '@/lib/integrations/mercadolivre/log'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import type { ChannelAdapter, ChannelFetchResult, ChannelListingSnapshot, ListingLocalStatus } from '@/lib/channels/types'
import {
  externalPriceTransition,
  offerKnownPrice,
  resolveDeps,
  type ChannelContext,
  type ListingRow,
  type ListingsServiceDeps,
} from './listings.service'

export interface ReconcileDivergence {
  code: 'external_price' | 'status_external' | 'closed_external' | 'moderation' | 'quantity' | 'listing_type'
  message: string
}

export interface ReconcileRepo {
  /** Reserva o lote (carimba last_reconciled_at). Linhas de TODAS as empresas — cada uma com seu company_id. */
  claim(limit: number, minAgeSeconds: number): Promise<ListingRow[]>
  /** Grava só se a linha não mudou desde o claim (updated_at). */
  updateGuarded(companyId: number, listingId: number, expectedUpdatedAt: string | undefined, patch: Partial<ListingRow>): Promise<boolean>
}

export interface PeriodicReconcileDeps {
  repo?: ReconcileRepo
  resolveChannel?: ListingsServiceDeps['resolveChannel']
  adapterFor?: ListingsServiceDeps['adapterFor']
  now?: () => Date
}

export interface PeriodicReconcileResult {
  claimed: number
  reconciled: number
  changed: number
  failed: number
  skipped_concurrent: number
  errors: Array<{ listing_id: number; company_id: number; error: string }>
}

const STATUS_LABEL: Record<string, string> = {
  active: 'ativo', paused: 'pausado', closed: 'finalizado', under_review: 'em revisão pelo Mercado Livre',
  inactive: 'inativo', payment_required: 'pagamento pendente', not_yet_active: 'ainda não ativo',
}
const SUB_STATUS_LABEL: Record<string, string> = {
  paused_by_seller: 'pausado pelo vendedor', out_of_stock: 'sem estoque', under_review: 'em revisão',
  waiting_for_patch: 'aguardando correção (moderação)', held: 'retido pelo Mercado Livre', forbidden: 'proibido (moderação)',
  suspended: 'suspenso', deleted: 'excluído', expired: 'expirado', freezed: 'congelado',
  pending_documentation: 'documentação pendente', picture_download_pending: 'imagens pendentes', warning: 'com advertência',
}
const MODERATION_STATUS = new Set(['under_review', 'inactive', 'payment_required'])
const MODERATION_SUB = new Set(['under_review', 'waiting_for_patch', 'held', 'forbidden', 'suspended', 'pending_documentation', 'freezed', 'warning'])

/** Texto do status do canal com o motivo (pausa/moderação), para a UI. */
export function describeExternalStatus(status: string | null, sub: string[]): string | null {
  if (!status) return null
  const base = STATUS_LABEL[status] ?? status
  const reasons = sub.map((s) => SUB_STATUS_LABEL[s] ?? s)
  return reasons.length ? `${base} (${reasons.join(', ')})` : base
}

/**
 * Status LOCAL a partir do canal, na reconciliação: reflete o que mudou lá
 * fora, sem nunca "corrigir" o canal.
 *   closed                    → closed
 *   active                    → active (inclusive reativado direto no canal)
 *   paused + paused_by_seller → paused (pausado direto no canal)
 *   paused por falta de estoque / moderação / revisão → mantém o local
 *   (o canal é que está bloqueando; divergência fica visível na UI)
 */
export function reconcileLocalStatus(current: ListingLocalStatus, status: string | null, sub: string[]): ListingLocalStatus {
  if (status === 'closed') return 'closed'
  if (status === 'active') return 'active'
  if (status === 'paused' && sub.includes('paused_by_seller')) return 'paused'
  return current
}

/** Patch local (puro) para um anúncio a partir do item observado no canal. */
export function reconcilePatch(row: ListingRow, snap: ChannelListingSnapshot, nowIso: string): { patch: Partial<ListingRow>; divergences: ReconcileDivergence[]; changed: boolean } {
  const divergences: ReconcileDivergence[] = []
  const sub = snap.externalSubStatus ?? []

  // Preço: MESMA regra do syncListing. Nunca toca o preço-base do produto.
  const known = offerKnownPrice(row)
  const price = externalPriceTransition(row, snap.price, nowIso)
  const priceChanged = price?.channel_price != null
  if (priceChanged) divergences.push({ code: 'external_price', message: `Preço alterado no canal: ${known} → ${snap.price}` })

  const localStatus = reconcileLocalStatus(row.local_status, snap.externalStatus, sub)
  const reason = describeExternalStatus(snap.externalStatus, sub)
  if (localStatus === 'closed' && row.local_status !== 'closed') {
    divergences.push({ code: 'closed_external', message: `Anúncio finalizado no canal${reason ? `: ${reason}` : ''}.` })
  } else if (localStatus !== row.local_status) {
    divergences.push({ code: 'status_external', message: localStatus === 'paused' ? 'Anúncio pausado direto no canal.' : 'Anúncio reativado direto no canal.' })
  }
  if (snap.externalStatus !== 'closed' && (MODERATION_STATUS.has(snap.externalStatus ?? '') || sub.some((s) => MODERATION_SUB.has(s)))) {
    divergences.push({ code: 'moderation', message: `Anúncio com restrição no canal: ${reason}.` })
  }
  if (snap.externalStatus !== 'closed' && snap.quantity != null && row.synced_quantity != null && snap.quantity !== row.synced_quantity) {
    divergences.push({ code: 'quantity', message: `Quantidade no canal (${snap.quantity}) diferente da última enviada pelo Qarvon (${row.synced_quantity}).` })
  }
  const currentType = row.listing_type_id ?? null
  if (snap.listingTypeId && currentType && snap.listingTypeId !== currentType) {
    divergences.push({ code: 'listing_type', message: `Tipo de anúncio alterado no canal: ${currentType} → ${snap.listingTypeId}.` })
  }

  const meta = ((price?.metadata ?? row.metadata) ?? {}) as Record<string, unknown>
  const patch: Partial<ListingRow> = {
    external_status: snap.externalStatus,
    external_sub_status: sub,
    permalink: snap.permalink ?? row.permalink,
    external_product_id: snap.externalProductId ?? row.external_product_id,
    external_group_id: snap.externalGroupId ?? row.external_group_id,
    external_ids: { ...(row.external_ids ?? {}), ...snap.externalIds },
    external_category_id: snap.externalCategoryId ?? row.external_category_id,
    listing_type_id: snap.listingTypeId ?? row.listing_type_id,
    local_status: localStatus,
    ...(priceChanged ? { channel_price: price!.channel_price } : {}),
    metadata: {
      ...meta,
      reconcile: {
        at: nowIso,
        observed: { price: snap.price, quantity: snap.quantity, status: snap.externalStatus, sub_status: sub, title: snap.title },
        status_reason: reason,
        divergences,
      },
    },
  }
  const changed = priceChanged || localStatus !== row.local_status
    || (snap.externalStatus ?? null) !== (row.external_status ?? null)
    || JSON.stringify(sub) !== JSON.stringify(row.external_sub_status ?? [])
    || (snap.listingTypeId != null && snap.listingTypeId !== currentType)
  return { patch, divergences, changed }
}

function errorText(err: unknown): string {
  if (isMercadoLivreError(err)) return `${err.kind}: ${err.message}`.slice(0, 500)
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}

function log(ctx: Pick<ChannelContext, 'companyId' | 'integrationId'> | { companyId: number; integrationId: number | null }, event: 'periodic_reconciled' | 'periodic_reconcile_failed', fields: Record<string, unknown>) {
  logMercadoLivre(`mercadolivre.listing.${event}`, { company_id: ctx.companyId, integration_id: ctx.integrationId, ...fields })
}

async function readAll(adapter: ChannelAdapter, ids: string[]): Promise<ChannelFetchResult[]> {
  if (adapter.fetchListings) return adapter.fetchListings(ids)
  const out: ChannelFetchResult[] = []
  for (const id of ids) {
    try {
      out.push({ externalListingId: id, snapshot: await adapter.fetchListing({ externalListingId: id }), error: null })
    } catch (err) {
      if (isMercadoLivreError(err) && (err.kind === 'reauth_required')) throw err
      out.push({ externalListingId: id, snapshot: null, error: { status: null, message: errorText(err) } })
    }
  }
  return out
}

export async function runPeriodicListingReconcile(
  options: { limit?: number; minAgeSeconds?: number } = {},
  deps: PeriodicReconcileDeps = {},
): Promise<PeriodicReconcileResult> {
  // Defaults do listings.service só quando não injetados (evita criar clientes à toa).
  const defaults = deps.resolveChannel && deps.adapterFor ? null : resolveDeps()
  const base = {
    resolveChannel: deps.resolveChannel ?? defaults!.resolveChannel,
    adapterFor: deps.adapterFor ?? defaults!.adapterFor,
  }
  const repo = deps.repo ?? createSupabaseReconcileRepo()
  const now = deps.now ?? (() => new Date())
  const result: PeriodicReconcileResult = { claimed: 0, reconciled: 0, changed: 0, failed: 0, skipped_concurrent: 0, errors: [] }

  const rows = await repo.claim(options.limit ?? 100, options.minAgeSeconds ?? 3600)
  result.claimed = rows.length

  const fail = async (row: ListingRow, message: string) => {
    result.failed++
    result.errors.push({ listing_id: row.id, company_id: row.company_id, error: message })
    try {
      await repo.updateGuarded(row.company_id, row.id, row.updated_at, { last_reconcile_error: message })
    } catch { /* o erro já está no resultado do job */ }
  }

  const byCompany = new Map<number, ListingRow[]>()
  for (const r of rows) byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r])

  for (const [companyId, list] of byCompany) {
    let ctx: ChannelContext
    try {
      ctx = await base.resolveChannel(companyId)
    } catch (err) {
      for (const r of list) await fail(r, `Canal indisponível: ${errorText(err)}`)
      log({ companyId, integrationId: null }, 'periodic_reconcile_failed', { reason: 'channel_unavailable' })
      continue
    }
    // Isolamento: só anúncios da conta conectada DESTA empresa.
    const own = list.filter((r) => r.company_id === ctx.companyId && r.integration_id === ctx.integrationId)
    for (const r of list.filter((x) => !own.includes(x))) await fail(r, 'Anúncio pertence a uma conta do canal que não está mais conectada.')
    if (own.length === 0) continue

    let reads: ChannelFetchResult[]
    try {
      reads = await readAll(base.adapterFor(ctx), own.map((r) => r.external_listing_id!))
    } catch (err) {
      for (const r of own) await fail(r, errorText(err))
      log(ctx, 'periodic_reconcile_failed', { reason: isMercadoLivreError(err) ? err.kind : 'error' })
      continue
    }
    const byId = new Map(reads.map((x) => [x.externalListingId, x]))

    for (const row of own) {
      try {
        const read = byId.get(row.external_listing_id!)
        if (!read?.snapshot) {
          await fail(row, read?.error?.status === 404 ? 'Anúncio não encontrado no canal (404).' : `Falha ao ler o anúncio: ${read?.error?.message ?? 'sem resposta'}`)
          continue
        }
        const snap = read.snapshot
        if (snap.sellerId && snap.sellerId !== ctx.sellerId) {
          await fail(row, `Anúncio ${snap.externalListingId} pertence a outra conta do canal; nada foi atualizado.`)
          continue
        }
        const nowIso = now().toISOString()
        const { patch, changed } = reconcilePatch(row, snap, nowIso)
        const ok = await repo.updateGuarded(companyId, row.id, row.updated_at, { ...patch, last_reconciled_at: nowIso, last_reconcile_error: null })
        if (!ok) { result.skipped_concurrent++; continue }
        result.reconciled++
        if (changed) {
          result.changed++
          log(ctx, 'periodic_reconciled', { listing_id: row.id, external_listing_id: row.external_listing_id, reason: 'changed' })
        }
      } catch (err) {
        await fail(row, errorText(err))
      }
    }
  }
  return result
}

export function createSupabaseReconcileRepo(): ReconcileRepo {
  const admin = createAdminClient() as any
  return {
    async claim(limit, minAgeSeconds) {
      const { data, error } = await admin.rpc('rpc_claim_channel_listings_reconcile', { p_limit: limit, p_min_age_seconds: minAgeSeconds })
      if (error) throw new Error(`Falha ao reservar lote de reconciliação: ${error.message}`)
      return (data ?? []) as ListingRow[]
    },
    async updateGuarded(companyId, listingId, expectedUpdatedAt, patch) {
      let q = admin.from('channel_listings').update(patch).eq('id', listingId).eq('company_id', companyId)
      if (expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt)
      const { data, error } = await q.select('id')
      if (error) throw new Error(`Falha ao gravar reconciliação: ${error.message}`)
      return Array.isArray(data) && data.length === 1
    },
  }
}
