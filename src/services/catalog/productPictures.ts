/**
 * Imagens de produto do Media Hub para canais externos (Mercado Livre,
 * Nuvemshop…). Neutro: não conhece nenhum canal.
 *
 * Só devolve mídia que um serviço externo consegue BAIXAR sozinho:
 *   - vínculo (`media_usages`) e mídia (`media`) da MESMA empresa;
 *   - role 'primary' ou 'gallery';
 *   - `media.active = true` e `visibility = 'public'` (bucket media-public,
 *     URL estável via resolveMediaUrl — nunca signed URL temporária).
 *
 * Ordem dentro de uma entidade: principal primeiro, depois galeria pela
 * `position` do vínculo (desempate: criação do vínculo) — a mesma ordem que
 * o Mercado Livre já usava via listMediaByEntity + "primary primeiro".
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveMediaUrl, type Media } from '@/services/media.service'
import type { MediaUsageRole } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

export type PictureEntityType = 'product' | 'product_variation'

export interface ProductPicture {
  /** media.public_id — identidade da mídia (dedupe entre produto e variações). */
  publicId: string
  url: string
  role: 'primary' | 'gallery'
  entityType: PictureEntityType
  entityId: string
  /** media_usages.position (ordem da galeria na entidade). */
  usagePosition: number
  mimeType: string | null
  extension: string | null
  status: string
}

/** Imagem já ordenada para envio, com posição final sequencial (1 = principal). */
export interface OrderedProductPicture extends ProductPicture {
  position: number
}

const PICTURE_ROLES: MediaUsageRole[] = ['primary', 'gallery']

type UsageRow = {
  id: number
  entity_id: string
  role: MediaUsageRole
  position: number
  created_at: string
  media: Media
}

function primaryFirst(list: ProductPicture[]): ProductPicture[] {
  // Array.prototype.sort é estável: a ordem role/position/created_at do banco
  // é preservada dentro de cada grupo.
  return [...list].sort((a, b) => (a.role === 'primary' ? -1 : 0) - (b.role === 'primary' ? -1 : 0))
}

/**
 * Imagens públicas de N entidades do MESMO tipo, numa consulta.
 * Devolve Map entityId → imagens ordenadas (principal primeiro).
 * Erro de banco → `ok: false` (quem chama decide se isso é "sem imagem").
 */
export async function loadEntityPictures(
  companyId: number,
  entityType: PictureEntityType,
  entityIds: string[],
): Promise<ServiceOutcome<Map<string, ProductPicture[]>>> {
  const out = new Map<string, ProductPicture[]>()
  const ids = [...new Set(entityIds.filter(Boolean))]
  if (ids.length === 0) return { ok: true, data: out }

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('media_usages')
    .select('id, entity_id, role, position, created_at, media:media_id!inner (*)')
    .eq('company_id', companyId)
    .eq('media.company_id', companyId)
    .eq('entity_type', entityType)
    .in('entity_id', ids)
    .in('role', PICTURE_ROLES)
    .order('role', { ascending: true })
    .order('position', { ascending: true })
    .order('created_at', { ascending: true }) as { data: UsageRow[] | null; error: { message: string } | null }

  if (error) return { ok: false, error: error.message, status: 500 }

  for (const row of data ?? []) {
    const media = row.media
    if (!media || media.company_id !== companyId) continue
    if (!media.active || media.visibility !== 'public') continue
    const resolved = await resolveMediaUrl(media)
    if (!resolved.ok || resolved.data.expiresAt) continue
    const list = out.get(row.entity_id) ?? []
    list.push({
      publicId:      media.public_id,
      url:           resolved.data.url,
      role:          row.role as 'primary' | 'gallery',
      entityType,
      entityId:      row.entity_id,
      usagePosition: row.position,
      mimeType:      media.mime_type ?? null,
      extension:     media.extension ?? null,
      status:        String(media.status ?? 'ready'),
    })
    out.set(row.entity_id, list)
  }

  for (const [key, list] of out) out.set(key, primaryFirst(list))
  return { ok: true, data: out }
}

/**
 * Ordem "produto primeiro" (catálogo com todas as variações num produto só):
 *   1. principal do produto; 2. galeria do produto;
 *   3. principal de cada variação; 4. galeria de cada variação
 *   (variações na ordem recebida). Sem mídia nem URL repetida; posição final
 *   sequencial a partir de 1.
 */
export function orderPicturesProductFirst(
  productPictures: ProductPicture[],
  variationPictures: ProductPicture[][],
): OrderedProductPicture[] {
  const sequence = [
    ...primaryFirst(productPictures),
    ...variationPictures.flatMap((list) => primaryFirst(list).filter((p) => p.role === 'primary')),
    ...variationPictures.flatMap((list) => primaryFirst(list).filter((p) => p.role !== 'primary')),
  ]
  const seenMedia = new Set<string>()
  const seenUrl = new Set<string>()
  const out: OrderedProductPicture[] = []
  for (const p of sequence) {
    if (seenMedia.has(p.publicId) || seenUrl.has(p.url)) continue
    seenMedia.add(p.publicId)
    seenUrl.add(p.url)
    out.push({ ...p, position: out.length + 1 })
  }
  return out
}

/** Carrega e ordena (produto primeiro) as imagens de um produto e suas variações. */
export async function loadProductPicturesProductFirst(
  companyId: number,
  productId: number,
  variationIds: number[],
): Promise<ServiceOutcome<OrderedProductPicture[]>> {
  const [product, variations] = await Promise.all([
    loadEntityPictures(companyId, 'product', [String(productId)]),
    loadEntityPictures(companyId, 'product_variation', variationIds.map(String)),
  ])
  if (!product.ok) return product
  if (!variations.ok) return variations
  return {
    ok: true,
    data: orderPicturesProductFirst(
      product.data.get(String(productId)) ?? [],
      variationIds.map((id) => variations.data.get(String(id)) ?? []),
    ),
  }
}

/**
 * URLs para o anúncio de UMA variação (grão do Mercado Livre): imagens da
 * variação, depois as do produto; URL repetida removida mantendo a primeira.
 * Falha de leitura de uma entidade = lista vazia daquela entidade (mesmo
 * comportamento anterior do ML). `legacyPhotoUrl` só entra se nada vier do
 * Media Hub.
 */
export async function loadVariationListingPictureUrls(
  companyId: number,
  productId: number,
  variationId: number,
  loadLegacyPhotoUrl?: () => Promise<string | null>,
): Promise<string[]> {
  const [variation, product] = await Promise.all([
    loadEntityPictures(companyId, 'product_variation', [String(variationId)]),
    loadEntityPictures(companyId, 'product', [String(productId)]),
  ])
  const urls = [
    ...(variation.ok ? (variation.data.get(String(variationId)) ?? []) : []),
    ...(product.ok ? (product.data.get(String(productId)) ?? []) : []),
  ].map((p) => p.url)
  if (urls.length === 0 && loadLegacyPhotoUrl) {
    const legacy = await loadLegacyPhotoUrl()
    if (legacy) urls.push(legacy)
  }
  return [...new Set(urls)]
}

// ─── Validação para ingestão por URL ──────────────────────────────────────────

export interface PublicPictureCheck {
  valid: OrderedProductPicture[]
  invalid: Array<{ url: string; reason: string }>
}

/**
 * Confere que a URL é baixável por terceiros e o formato é aceito pelo
 * canal (extensões em minúsculas, sem ponto). Re-sequencia `position`.
 */
export function validatePublicPictures(pictures: OrderedProductPicture[], acceptedExtensions: string[]): PublicPictureCheck {
  const accepted = new Set(acceptedExtensions)
  const valid: OrderedProductPicture[] = []
  const invalid: Array<{ url: string; reason: string }> = []
  for (const p of pictures) {
    let parsed: URL
    try {
      parsed = new URL(p.url)
    } catch {
      invalid.push({ url: p.url, reason: 'URL inválida' })
      continue
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      invalid.push({ url: p.url, reason: 'URL precisa ser http(s) pública' })
      continue
    }
    if (parsed.searchParams.has('token') || /\/object\/sign\//.test(parsed.pathname)) {
      invalid.push({ url: p.url, reason: 'URL assinada (expira) não pode ser usada' })
      continue
    }
    if (p.status !== 'ready') {
      invalid.push({ url: p.url, reason: `mídia não está pronta (${p.status})` })
      continue
    }
    const ext = (p.extension ?? parsed.pathname.split('.').pop() ?? '').toLowerCase()
    if (!accepted.has(ext)) {
      invalid.push({ url: p.url, reason: `formato .${ext || '?'} não aceito` })
      continue
    }
    valid.push({ ...p, position: valid.length + 1 })
  }
  return { valid, invalid }
}
