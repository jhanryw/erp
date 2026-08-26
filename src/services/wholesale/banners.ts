/**
 * Banners rotativos da vitrine de atacado (seções 14-21 do pedido) —
 * Configurações → Atacado → Catálogo Online → "Banners da vitrine".
 *
 * Reaproveita a tabela `media` (mesmo bucket `media-public` já usado por
 * produto/logo) através de `wholesale_site_banners.media_id` — nunca
 * `media_usages` (role='banner' é singular por entidade, incompatível com
 * "vários banners por empresa", ver migration 202609050900). Upload real
 * continua passando por `POST /api/media` (visibility='public'), que já
 * restringe a jpeg/png/webp — nenhuma segunda validação de MIME aqui.
 *
 * `company_id` nunca vem do cliente — sempre parâmetro explícito resolvido
 * pela sessão (admin) ou pelo tenant do site (público), mesma regra do
 * resto do site de atacado.
 */

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveMediaUrl } from '@/services/media.service'

export type BannerLinkType = 'none' | 'category' | 'product' | 'url'

/**
 * Validação do destino do link do banner (seção 19 do pedido) — única
 * definição, reaproveitada pelas rotas POST e PATCH (nunca duplicada).
 * Só http:/https: — rejeita javascript:/data:/qualquer outro esquema
 * explicitamente, nunca confia em `new URL().protocol` sozinho sem essa
 * allowlist positiva.
 */
export const wholesaleBannerLinkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('category'), categorySlug: z.string().min(1) }),
  z.object({ type: z.literal('product'), productId: z.number().int().positive() }),
  z.object({
    type: z.literal('url'),
    url: z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'URL precisa começar com http:// ou https://'),
  }),
])

export interface WholesaleBannerLink {
  type: BannerLinkType
  categorySlug?: string
  productId?: number
  url?: string
}

export interface WholesaleBanner {
  id: number
  mediaPublicId: string
  imageUrl: string
  altText: string | null
  isActive: boolean
  sortOrder: number
  link: WholesaleBannerLink
}

interface BannerRow {
  id: number
  is_active: boolean
  sort_order: number
  link_type: BannerLinkType
  link_url: string | null
  media: { public_id: string; alt_text: string | null; visibility: 'public' | 'private'; storage_key: string | null; external_url: string | null } | { public_id: string; alt_text: string | null; visibility: 'public' | 'private'; storage_key: string | null; external_url: string | null }[] | null
  categories: { slug: string } | { slug: string }[] | null
  products: { id: number } | { id: number }[] | null
}

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v
}

const BANNER_SELECT = `
  id, is_active, sort_order, link_type, link_url,
  media:media_id(public_id, alt_text, visibility, storage_key, external_url),
  categories:link_category_id(slug),
  products:link_product_id(id)
`

async function fromRow(row: BannerRow): Promise<WholesaleBanner> {
  const media = one(row.media)
  const category = one(row.categories)
  const product = one(row.products)

  const link: WholesaleBannerLink = { type: row.link_type }
  if (row.link_type === 'category' && category) link.categorySlug = category.slug
  if (row.link_type === 'product' && product) link.productId = product.id
  if (row.link_type === 'url' && row.link_url) link.url = row.link_url

  // Reaproveita `resolveMediaUrl` do Media Hub (mesma função que resolve
  // imagem de produto/logo) — nunca uma segunda lógica de URL de storage.
  const resolved = media ? await resolveMediaUrl(media as any) : null

  return {
    id: row.id,
    mediaPublicId: media?.public_id ?? '',
    imageUrl: resolved?.ok ? resolved.data.url : '',
    altText: media?.alt_text ?? null,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    link,
  }
}

/** Listagem completa (ativos e inativos, ordenados) — tela de administração. */
export async function listWholesaleBanners(companyId: number): Promise<WholesaleBanner[]> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('wholesale_site_banners')
    .select(BANNER_SELECT)
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true }) as { data: any[] | null }

  return Promise.all((data ?? []).map(fromRow))
}

/** Só banners ativos, ordenados — usado pelo catálogo público (carrossel/estático). */
export async function getActiveWholesaleBanners(companyId: number): Promise<WholesaleBanner[]> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('wholesale_site_banners')
    .select(BANNER_SELECT)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true }) as { data: any[] | null }

  return Promise.all((data ?? []).map(fromRow))
}

export interface CreateWholesaleBannerInput {
  mediaPublicId: string
  link: WholesaleBannerLink
}

export type BannerMutationResult =
  | { ok: true; data: WholesaleBanner }
  | { ok: false; error: string; status: number }

async function resolveMediaId(admin: ReturnType<typeof createAdminClient>, companyId: number, mediaPublicId: string): Promise<number | null> {
  const { data } = await (admin as any)
    .from('media')
    .select('id')
    .eq('company_id', companyId)
    .eq('public_id', mediaPublicId)
    .eq('visibility', 'public')
    .maybeSingle() as { data: { id: number } | null }
  return data?.id ?? null
}

export async function createWholesaleBanner(companyId: number, input: CreateWholesaleBannerInput): Promise<BannerMutationResult> {
  const admin = createAdminClient()

  const mediaId = await resolveMediaId(admin, companyId, input.mediaPublicId)
  if (!mediaId) return { ok: false, error: 'Imagem não encontrada ou não pertence a esta empresa.', status: 404 }

  if (input.link.type === 'category') {
    const ok = await categoryBelongsToCompany(admin, companyId, input.link.categorySlug)
    if (!ok) return { ok: false, error: 'Categoria inválida.', status: 422 }
  }
  if (input.link.type === 'product') {
    const ok = await productBelongsToCompany(admin, companyId, input.link.productId)
    if (!ok) return { ok: false, error: 'Produto inválido.', status: 422 }
  }

  const { data: maxRow } = await (admin as any)
    .from('wholesale_site_banners')
    .select('sort_order')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { sort_order: number } | null }

  const nextSortOrder = (maxRow?.sort_order ?? -1) + 1

  const { data, error } = await (admin as any)
    .from('wholesale_site_banners')
    .insert({
      company_id: companyId,
      media_id: mediaId,
      sort_order: nextSortOrder,
      ...(await resolvedLinkColumns(admin, companyId, input.link)),
    })
    .select(BANNER_SELECT)
    .single() as { data: any | null; error: { message: string } | null }

  if (error || !data) return { ok: false, error: error?.message ?? 'Falha ao criar banner.', status: 500 }
  return { ok: true, data: await fromRow(data) }
}

async function categoryBelongsToCompany(admin: ReturnType<typeof createAdminClient>, companyId: number, slug: string | undefined): Promise<boolean> {
  if (!slug) return false
  const { data } = await (admin as any).from('categories').select('id').eq('company_id', companyId).eq('slug', slug).maybeSingle()
  return !!data
}

async function productBelongsToCompany(admin: ReturnType<typeof createAdminClient>, companyId: number, productId: number | undefined): Promise<boolean> {
  if (!productId) return false
  const { data } = await (admin as any).from('products').select('id').eq('company_id', companyId).eq('id', productId).maybeSingle()
  return !!data
}

async function resolvedLinkColumns(admin: ReturnType<typeof createAdminClient>, companyId: number, link: WholesaleBannerLink) {
  if (link.type === 'category') {
    const { data } = await (admin as any).from('categories').select('id').eq('company_id', companyId).eq('slug', link.categorySlug).maybeSingle() as { data: { id: number } | null }
    return { link_type: 'category', link_category_id: data?.id ?? null, link_product_id: null, link_url: null }
  }
  if (link.type === 'product') {
    return { link_type: 'product', link_category_id: null, link_product_id: link.productId ?? null, link_url: null }
  }
  if (link.type === 'url') {
    return { link_type: 'url', link_category_id: null, link_product_id: null, link_url: link.url ?? null }
  }
  return { link_type: 'none', link_category_id: null, link_product_id: null, link_url: null }
}

export interface UpdateWholesaleBannerInput {
  isActive?: boolean
  link?: WholesaleBannerLink
}

export async function updateWholesaleBanner(companyId: number, bannerId: number, patch: UpdateWholesaleBannerInput): Promise<BannerMutationResult> {
  const admin = createAdminClient()

  const { data: existing } = await (admin as any)
    .from('wholesale_site_banners')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', bannerId)
    .maybeSingle() as { data: { id: number } | null }
  if (!existing) return { ok: false, error: 'Banner não encontrado.', status: 404 }

  if (patch.link?.type === 'category') {
    const ok = await categoryBelongsToCompany(admin, companyId, patch.link.categorySlug)
    if (!ok) return { ok: false, error: 'Categoria inválida.', status: 422 }
  }
  if (patch.link?.type === 'product') {
    const ok = await productBelongsToCompany(admin, companyId, patch.link.productId)
    if (!ok) return { ok: false, error: 'Produto inválido.', status: 422 }
  }

  const updates: Record<string, unknown> = {}
  if (patch.isActive !== undefined) updates.is_active = patch.isActive
  if (patch.link !== undefined) Object.assign(updates, await resolvedLinkColumns(admin, companyId, patch.link))

  const { data, error } = await (admin as any)
    .from('wholesale_site_banners')
    .update(updates)
    .eq('company_id', companyId)
    .eq('id', bannerId)
    .select(BANNER_SELECT)
    .single() as { data: any | null; error: { message: string } | null }

  if (error || !data) return { ok: false, error: error?.message ?? 'Falha ao atualizar banner.', status: 500 }
  return { ok: true, data: await fromRow(data) }
}

export async function deleteWholesaleBanner(companyId: number, bannerId: number): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const admin = createAdminClient()
  const { error, count } = await (admin as any)
    .from('wholesale_site_banners')
    .delete({ count: 'exact' })
    .eq('company_id', companyId)
    .eq('id', bannerId) as { error: { message: string } | null; count: number | null }

  if (error) return { ok: false, error: error.message, status: 500 }
  if (!count) return { ok: false, error: 'Banner não encontrado.', status: 404 }
  return { ok: true }
}

/**
 * Reordena todos os banners da empresa de uma vez — `bannerIds` na nova
 * ordem desejada. Ignora silenciosamente qualquer id que não pertença à
 * empresa (nunca deixa um id de outra empresa alterar sort_order aqui).
 */
export async function reorderWholesaleBanners(companyId: number, bannerIds: number[]): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const admin = createAdminClient()

  const { data: owned } = await (admin as any)
    .from('wholesale_site_banners')
    .select('id')
    .eq('company_id', companyId)
    .in('id', bannerIds) as { data: { id: number }[] | null }

  const ownedIds = new Set((owned ?? []).map((r) => r.id))
  const updates = bannerIds
    .filter((id) => ownedIds.has(id))
    .map((id, index) => (admin as any).from('wholesale_site_banners').update({ sort_order: index }).eq('company_id', companyId).eq('id', id))

  const results = await Promise.all(updates)
  const failed = results.find((r: any) => r.error)
  if (failed) return { ok: false, error: failed.error.message, status: 500 }
  return { ok: true }
}
