/**
 * Capas das categorias do atacado (Configurações → Atacado → Categorias).
 *
 * Reaproveita o Media Hub (`media`, bucket público) através de `wholesale_category_covers`.
 * `company_id` nunca vem do cliente. Só categorias DA PRÓPRIA empresa aceitam capa — categoria
 * legada compartilhada (company_id nulo) não é editável por um tenant.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveMediaUrl } from '@/services/media.service'
import { loadCategoryUniverse } from './categoryKeys'
import { invalidateWholesaleCompany } from '@/lib/wholesale/ttlCache'

type Admin = ReturnType<typeof createAdminClient>

interface CoverRow {
  category_id: number
  media: { public_id: string; alt_text: string | null; visibility: 'public' | 'private'; storage_key: string | null; external_url: string | null; active: boolean }
    | { public_id: string; alt_text: string | null; visibility: 'public' | 'private'; storage_key: string | null; external_url: string | null; active: boolean }[]
    | null
}

export interface CategoryCover { url: string; alt: string | null; mediaPublicId: string }

/** Capas resolvidas (URL pública) por `category_id`. Capa cuja mídia não resolve é omitida. */
export async function loadCategoryCovers(admin: Admin, companyId: number, categoryIds: number[]): Promise<Map<number, CategoryCover>> {
  const covers = new Map<number, CategoryCover>()
  if (categoryIds.length === 0) return covers

  const { data } = await (admin as any)
    .from('wholesale_category_covers')
    .select('category_id, media:media_id(public_id, alt_text, visibility, storage_key, external_url, active)')
    .eq('company_id', companyId)
    .in('category_id', categoryIds) as { data: CoverRow[] | null }

  await Promise.all((data ?? []).map(async (row) => {
    const media = Array.isArray(row.media) ? row.media[0] : row.media
    if (!media || media.active === false || media.visibility !== 'public') return
    const resolved = await resolveMediaUrl(media as any)
    if (resolved.ok) covers.set(row.category_id, { url: resolved.data.url, alt: media.alt_text, mediaPublicId: media.public_id })
  }))
  return covers
}

export interface AdminCategoryCover {
  id: number
  name: string
  slug: string
  /** Valor público de `?categoria=` (ver categoryKeys.ts). */
  key: string
  active: boolean
  cover: CategoryCover | null
}

/** Categorias editáveis da empresa (as dela, não as legadas compartilhadas) com a capa atual. */
export async function listCategoriesWithCovers(companyId: number): Promise<AdminCategoryCover[]> {
  const admin = createAdminClient()
  const universe = await loadCategoryUniverse(admin, companyId)

  const { data: owned } = await (admin as any).from('categories').select('id').eq('company_id', companyId) as { data: { id: number }[] | null }
  const ownedIds = new Set((owned ?? []).map((r) => r.id))
  const own = universe.filter((c) => ownedIds.has(c.id))

  const covers = await loadCategoryCovers(admin, companyId, own.map((c) => c.id))
  return own
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, key: c.key, active: c.active, cover: covers.get(c.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
}

export type CoverMutationResult = { ok: true } | { ok: false; error: string; status: number }

export async function setCategoryCover(companyId: number, categoryId: number, mediaPublicId: string): Promise<CoverMutationResult> {
  const admin = createAdminClient()

  const { data: category } = await (admin as any)
    .from('categories').select('id').eq('id', categoryId).eq('company_id', companyId).maybeSingle() as { data: { id: number } | null }
  if (!category) return { ok: false, error: 'Categoria não encontrada para esta empresa.', status: 404 }

  const { data: media } = await (admin as any)
    .from('media').select('id')
    .eq('company_id', companyId).eq('public_id', mediaPublicId).eq('visibility', 'public').eq('active', true)
    .maybeSingle() as { data: { id: number } | null }
  if (!media) return { ok: false, error: 'Imagem não encontrada ou não pertence a esta empresa.', status: 404 }

  const { error } = await (admin as any)
    .from('wholesale_category_covers')
    .upsert({ company_id: companyId, category_id: categoryId, media_id: media.id }, { onConflict: 'company_id,category_id' })
  if (error) return { ok: false, error: error.message, status: 500 }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}

export async function removeCategoryCover(companyId: number, categoryId: number): Promise<CoverMutationResult> {
  const admin = createAdminClient()
  const { error, count } = await (admin as any)
    .from('wholesale_category_covers')
    .delete({ count: 'exact' })
    .eq('company_id', companyId)
    .eq('category_id', categoryId) as { error: { message: string } | null; count: number | null }
  if (error) return { ok: false, error: error.message, status: 500 }
  if (!count) return { ok: false, error: 'Esta categoria não tem capa.', status: 404 }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}
