/**
 * Resolve o contexto de canal Mercado Livre da EMPRESA DA SESSÃO para o
 * Marketplace Hub: conta conectada (Fase 1), site/moeda e modelo de
 * publicação (User Products × legado, pela tag `user_product_seller` de
 * /users/me). Única ponte entre o serviço genérico de listings e a
 * integração ML.
 */

import { fetchMe } from '@/lib/integrations/mercadolivre/users'
import { listingModelFromTags } from '@/lib/integrations/mercadolivre/adapter'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { createSupabaseMercadoLivreRepo } from '@/services/integrations/mercadolivre.service'
import { CURRENCY_BY_SITE, ListingError, createSupabaseListingSource, type ChannelContext } from './listings.service'
import {
  checkConditionalAttributes,
  getCategoryAttributes,
  getCategoryDetails,
  type AttributeDefinition,
  type CategoryDetails,
} from '@/lib/integrations/mercadolivre/catalog'
import { suggestAttributeValues } from '@/lib/integrations/mercadolivre/listingPayload'
import type { ChannelAttributeValue } from '@/lib/channels/types'

export async function resolveMercadoLivreChannel(companyId: number): Promise<ChannelContext> {
  const row = await createSupabaseMercadoLivreRepo().getIntegration(companyId)
  if (!row || row.status === 'inactive' || row.status === 'pending' || !row.external_account_id) {
    throw new ListingError('not_connected', 'Mercado Livre não está conectado nesta empresa.')
  }
  if (row.status === 'needs_reauth') {
    throw new ListingError('needs_reauth', 'A conexão com o Mercado Livre precisa ser reautorizada.')
  }

  const settings = (row.settings ?? {}) as { site_id?: string; nickname?: string; is_test_user?: boolean }
  const siteId = (settings.site_id ?? 'MLB').toUpperCase()

  let tags: string[] | undefined
  try {
    tags = (await fetchMe(row.id, companyId)).tags
  } catch (err) {
    if (isMercadoLivreError(err) && err.kind === 'reauth_required') {
      throw new ListingError('needs_reauth', 'A conexão com o Mercado Livre precisa ser reautorizada.')
    }
    throw err
  }

  return {
    provider: 'mercadolivre',
    integrationId: row.id,
    companyId,
    sellerId: row.external_account_id,
    siteId,
    currencyId: CURRENCY_BY_SITE[siteId] ?? 'BRL',
    model: listingModelFromTags(tags),
    accountLabel: settings.nickname ?? null,
    // Tag AO VIVO de /users/me (não o settings salvo): decide a trava de conta real.
    isTestAccount: Array.isArray(tags) ? tags.includes('test_user') : Boolean(settings.is_test_user),
  }
}

/** Conta conectada sem chamada externa (para consultas de catálogo). */
export async function getConnectedMercadoLivreIntegration(companyId: number): Promise<{ integrationId: number; siteId: string }> {
  const row = await createSupabaseMercadoLivreRepo().getIntegration(companyId)
  if (!row || row.status === 'inactive' || row.status === 'pending' || !row.external_account_id) {
    throw new ListingError('not_connected', 'Mercado Livre não está conectado nesta empresa.')
  }
  if (row.status === 'needs_reauth') throw new ListingError('needs_reauth', 'A conexão com o Mercado Livre precisa ser reautorizada.')
  const siteId = (((row.settings ?? {}) as { site_id?: string }).site_id ?? 'MLB').toUpperCase()
  return { integrationId: row.id, siteId }
}

// ─── Formulário de publicação (categoria + atributos dinâmicos) ──────────────

export interface MercadoLivrePublishForm {
  category: CategoryDetails
  /** Atributos iguais para todas as variações (marca, modelo, gênero…). */
  common_attributes: AttributeDefinition[]
  /** Atributos que variam por variação (cor, tamanho, GTIN…). */
  variation_attributes: AttributeDefinition[]
  suggestions: {
    common: ChannelAttributeValue[]
    by_variation: Record<number, ChannelAttributeValue[]>
  }
}

/**
 * Monta o formulário DINÂMICO a partir do que a categoria do ML exige —
 * nenhum atributo é hardcoded por segmento; o Qarvon só sugere valores
 * iniciais por semântica (marca, modelo, cor, tamanho) para o usuário conferir.
 */
export async function getMercadoLivrePublishForm(
  companyId: number,
  categoryId: string,
  productId: number | null,
): Promise<MercadoLivrePublishForm> {
  const { integrationId } = await getConnectedMercadoLivreIntegration(companyId)
  const ctx = { integrationId, companyId }
  const [category, attributes] = await Promise.all([getCategoryDetails(ctx, categoryId), getCategoryAttributes(ctx, categoryId)])
  if (!category.listing_allowed || category.children_count > 0) {
    throw new ListingError('missing_attributes', 'Escolha uma categoria final (folha) que aceite anúncios.')
  }

  const variationAttrs = attributes.filter((a) => a.varies_by_variation)
  const commonAttrs = attributes.filter((a) => !a.varies_by_variation)
  const suggestions: MercadoLivrePublishForm['suggestions'] = { common: [], by_variation: {} }

  if (productId) {
    const product = await createSupabaseListingSource().loadProduct(companyId, productId)
    if (!product) throw new ListingError('not_found', 'Produto não encontrado.')
    suggestions.common = suggestAttributeValues(commonAttrs, { brand: product.brand, model: product.model, color: null, size: null })
    for (const v of product.variations) {
      suggestions.by_variation[v.id] = suggestAttributeValues(variationAttrs, { brand: null, model: null, color: v.color, size: v.size })
    }
  }

  return { category, common_attributes: commonAttrs, variation_attributes: variationAttrs, suggestions }
}

/** Ids obrigatórios da categoria, calculados no SERVIDOR (não confia no cliente). */
export async function requiredAttributeIdsFor(
  companyId: number,
  categoryId: string,
  sampleAttributes: ChannelAttributeValue[],
): Promise<string[]> {
  const { integrationId } = await getConnectedMercadoLivreIntegration(companyId)
  const ctx = { integrationId, companyId }
  const attributes = await getCategoryAttributes(ctx, categoryId)
  const ids = new Set(attributes.filter((a) => a.required || a.new_required).map((a) => a.id))
  try {
    for (const id of await checkConditionalAttributes(ctx, categoryId, { attributes: sampleAttributes })) ids.add(id)
  } catch {
    // Consulta condicional é best-effort: se falhar, o próprio POST /items
    // devolve o atributo faltante (erro tipado com a mensagem do ML).
  }
  return [...ids]
}
