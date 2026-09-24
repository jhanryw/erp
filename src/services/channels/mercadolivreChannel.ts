/**
 * Resolve o contexto de canal Mercado Livre da EMPRESA DA SESSÃO para o
 * Marketplace Hub: conta conectada (Fase 1), site/moeda e modelo de
 * publicação (User Products × legado, pela tag `user_product_seller` de
 * /users/me). Única ponte entre o serviço genérico de listings e a
 * integração ML.
 */

import { fetchMe } from '@/lib/integrations/mercadolivre/users'
import type { MercadoLivreRequestDeps } from '@/lib/integrations/mercadolivre/client'
import { listingModelFromTags } from '@/lib/integrations/mercadolivre/adapter'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { createSupabaseMercadoLivreRepo } from '@/services/integrations/mercadolivre.service'
import { CURRENCY_BY_SITE, ListingError, assertPublishAllowed, createSupabaseListingSource, type ChannelContext } from './listings.service'
import {
  checkConditionalAttributes,
  getCategoryAttributes,
  getCategoryDetails,
  type AttributeDefinition,
  type CategoryDetails,
} from '@/lib/integrations/mercadolivre/catalog'
import { suggestAttributeValues } from '@/lib/integrations/mercadolivre/listingPayload'
import {
  SizeChartInputError,
  buildSizeChartBody,
  createSizeChart,
  detectSizeGrid,
  getChartTemplate,
  getSizeChart,
  getSizeChartFilterSpec,
  searchSizeCharts,
  type ChartCellValue,
  type ChartTemplate,
  type SizeChart,
  type SizeChartSummary,
  type SizeGridAttributes,
} from '@/lib/integrations/mercadolivre/sizeCharts'
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
export async function getConnectedMercadoLivreIntegration(companyId: number): Promise<{ integrationId: number; siteId: string; sellerId: string }> {
  const row = await createSupabaseMercadoLivreRepo().getIntegration(companyId)
  if (!row || row.status === 'inactive' || row.status === 'pending' || !row.external_account_id) {
    throw new ListingError('not_connected', 'Mercado Livre não está conectado nesta empresa.')
  }
  if (row.status === 'needs_reauth') throw new ListingError('needs_reauth', 'A conexão com o Mercado Livre precisa ser reautorizada.')
  const siteId = (((row.settings ?? {}) as { site_id?: string }).site_id ?? 'MLB').toUpperCase()
  return { integrationId: row.id, siteId, sellerId: row.external_account_id }
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
  /**
   * Categoria de moda com tabela de medidas: ids dos atributos de tabela e
   * de linha (resolvidos pela busca de tabelas, não digitados). null = não usa.
   */
  size_grid: SizeGridAttributes | null
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

  // Atributos de tabela de medidas não são digitados: vêm da busca de tabelas.
  const sizeGrid = detectSizeGrid(attributes)
  const gridIds = new Set(sizeGrid ? [sizeGrid.grid_attribute_id, sizeGrid.row_attribute_id] : [])
  const fillable = attributes.filter((a) => !gridIds.has(a.id) && a.value_type !== 'grid_id' && a.value_type !== 'grid_row_id')
  const variationAttrs = fillable.filter((a) => a.varies_by_variation)
  const commonAttrs = fillable.filter((a) => !a.varies_by_variation)
  const suggestions: MercadoLivrePublishForm['suggestions'] = { common: [], by_variation: {} }

  if (productId) {
    const product = await createSupabaseListingSource().loadProduct(companyId, productId)
    if (!product) throw new ListingError('not_found', 'Produto não encontrado.')
    suggestions.common = suggestAttributeValues(commonAttrs, { brand: product.brand, model: product.model, color: null, size: null })
    for (const v of product.variations) {
      suggestions.by_variation[v.id] = suggestAttributeValues(variationAttrs, { brand: null, model: null, color: v.color, size: v.size })
    }
  }

  return { category, common_attributes: commonAttrs, variation_attributes: variationAttrs, suggestions, size_grid: sizeGrid }
}

// ─── Tabela de medidas (moda) ────────────────────────────────────────────────

/**
 * Busca tabelas aplicáveis ao domínio com os filtros que a ficha técnica do
 * domínio exige (grid_template_required/grid_filter), usando os valores que o
 * usuário preencheu no formulário (ex.: gênero, marca).
 */
export async function searchMercadoLivreSizeCharts(
  companyId: number,
  domainId: string,
  attributes: ChannelAttributeValue[],
): Promise<{ charts: SizeChartSummary[]; filter_attribute_ids: string[] }> {
  const { integrationId, siteId, sellerId } = await getConnectedMercadoLivreIntegration(companyId)
  const ctx = { integrationId, companyId }
  const spec = await getSizeChartFilterSpec(ctx, domainId)
  const byId = new Map(attributes.map((a) => [a.id.toUpperCase(), a]))
  const filled = (id: string) => { const a = byId.get(id); return Boolean(a && ((a.value_name ?? '').toString().trim() || (a.value_id ?? '').toString().trim())) }
  const missing = spec.required.filter((id) => !filled(id))
  if (missing.length) {
    throw new ListingError('missing_attributes', `Preencha ${missing.join(', ')} antes de buscar a tabela de medidas.`)
  }
  const filters = spec.accepted.filter(filled).map((id) => byId.get(id)!)
  const charts = await searchSizeCharts(ctx, { domainId, siteId, sellerId, attributes: filters })
  return { charts, filter_attribute_ids: spec.accepted }
}

export async function getMercadoLivreSizeChart(companyId: number, chartId: string): Promise<SizeChart> {
  const { integrationId, siteId } = await getConnectedMercadoLivreIntegration(companyId)
  return getSizeChart({ integrationId, companyId }, chartId, siteId)
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

/** Valores de atributos (grid_template_required) exigidos pela ficha da tabela, vindos do formulário. */
function templateAttributesFrom(requiredIds: string[], attributes: ChannelAttributeValue[]): ChannelAttributeValue[] {
  const byId = new Map(attributes.map((a) => [a.id.toUpperCase(), a]))
  const missing = requiredIds.filter((id) => {
    const a = byId.get(id)
    return !(a && ((a.value_name ?? '').toString().trim() || (a.value_id ?? '').toString().trim()))
  })
  if (missing.length) throw new ListingError('missing_attributes', `Preencha ${missing.join(', ')} antes de criar a tabela de medidas.`)
  return requiredIds.map((id) => byId.get(id)!)
}

/**
 * Ficha técnica da TABELA para o domínio (campos gerais, candidatos a
 * atributo principal, atributos de linha, tipos de medida) — base do
 * formulário de criação. Nada é fixo: vem de
 * POST /domains/{domain_id}/technical_specs?section=grids.
 */
export async function getMercadoLivreSizeChartTemplate(
  companyId: number,
  domainId: string,
  attributes: ChannelAttributeValue[],
): Promise<ChartTemplate> {
  const { integrationId } = await getConnectedMercadoLivreIntegration(companyId)
  const ctx = { integrationId, companyId }
  const spec = await getSizeChartFilterSpec(ctx, domainId)
  return getChartTemplate(ctx, domainId, templateAttributesFrom(spec.required, attributes))
}

export interface CreateSizeChartInput {
  domainId: string
  name: string
  measureType: string | null
  mainAttributeId: string
  attributes: ChannelAttributeValue[]
  rows: Array<Record<string, ChartCellValue>>
}

/**
 * Cria uma tabela SPECIFIC para o seller conectado (POST /catalog/charts).
 * Escrita externa → mesma trava da publicação: só em usuário TEST do ML
 * (tag test_user ao vivo) salvo liberação explícita. O corpo é montado e
 * validado no SERVIDOR a partir da ficha da tabela recém-consultada.
 */
export async function createMercadoLivreSizeChart(companyId: number, input: CreateSizeChartInput): Promise<SizeChart> {
  return createSizeChartForChannel(await resolveMercadoLivreChannel(companyId), input)
}

/** Núcleo testável: trava TEST → ficha da tabela → corpo validado → POST → leitura. */
export async function createSizeChartForChannel(
  channel: ChannelContext,
  input: CreateSizeChartInput,
  deps?: MercadoLivreRequestDeps,
): Promise<SizeChart> {
  assertPublishAllowed(channel)
  const ctx = { integrationId: channel.integrationId, companyId: channel.companyId, deps }
  const spec = await getSizeChartFilterSpec(ctx, input.domainId)
  const template = await getChartTemplate(ctx, input.domainId, templateAttributesFrom(spec.required, input.attributes))
  let body: Record<string, unknown>
  try {
    body = buildSizeChartBody(template, {
      name: input.name, siteId: channel.siteId, domainId: input.domainId, measureType: input.measureType,
      mainAttributeId: input.mainAttributeId, attributes: input.attributes, rows: input.rows,
    })
  } catch (err) {
    if (err instanceof SizeChartInputError) throw new ListingError('missing_attributes', err.message)
    throw err
  }
  const created = await createSizeChart(ctx, body, channel.siteId)
  // A resposta do POST já traz as linhas; se vier sem, lê a tabela criada.
  return created.rows.length ? created : getSizeChart(ctx, created.id, channel.siteId)
}
