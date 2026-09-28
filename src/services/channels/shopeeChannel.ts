/**
 * Ponte entre o Marketplace Hub genérico e UMA loja Shopee.
 *
 * Multi-loja: a integração é SEMPRE a linha exata (company_id da sessão +
 * integration_id), nunca "a Shopee da empresa". Integração de outra empresa
 * = não encontrada. O shop_id vem da própria linha (external_account_id) e
 * precisa bater com settings.shop_id quando presente.
 */

import { isValidShopId } from '@/lib/integrations/shopee/oauth'
import type { ShopeeRequestDeps, ShopeeShopContext } from '@/lib/integrations/shopee/client'
import {
  findCategory,
  getBrandList,
  getCategories,
  getCategoryAttributes,
  getLogisticsChannels,
  type ShopeeAttributeDefinition,
  type ShopeeBrandInfo,
  type ShopeeCategory,
  type ShopeeLogisticsChannel,
} from '@/lib/integrations/shopee/catalog'
import { loadRequirementsSnapshot, toPublishRequirements, type ShopeePublishRequirements } from '@/lib/integrations/shopee/requirements'
import { createSupabaseShopeeRepo, type ShopeeRepo } from '@/services/integrations/shopee.service'
import { ListingError, type ChannelContext } from './listings.service'

export interface ShopeeChannelDeps {
  repo?: ShopeeRepo
  request?: ShopeeRequestDeps
}

export async function resolveShopeeChannel(companyId: number, integrationId: number, deps: ShopeeChannelDeps = {}): Promise<ChannelContext> {
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    throw new ListingError('not_connected', 'Informe a loja Shopee (integration_id).')
  }
  const row = await (deps.repo ?? createSupabaseShopeeRepo()).getIntegration(companyId, integrationId)
  // getIntegration filtra company_id + provider='shopee': outra empresa → null.
  if (!row || row.company_id !== companyId) throw new ListingError('not_connected', 'Loja Shopee não encontrada nesta empresa.')
  if (row.status === 'needs_reauth') throw new ListingError('needs_reauth', 'A conexão com a Shopee precisa ser reautorizada.')
  if (row.status !== 'active' && row.status !== 'error') throw new ListingError('not_connected', 'Loja Shopee desconectada.')
  const shopId = row.external_account_id
  if (!isValidShopId(shopId)) throw new ListingError('not_connected', 'Loja Shopee sem shop_id válido.')
  const settingsShop = (row.settings as { shop_id?: unknown } | null)?.shop_id
  if (settingsShop != null && String(settingsShop) !== shopId) {
    throw new ListingError('not_connected', 'Integração Shopee inconsistente (shop_id divergente); reconecte a loja.')
  }
  return {
    provider: 'shopee',
    integrationId: row.id,
    companyId,
    sellerId: shopId,
    shopId,
    siteId: 'BR',
    currencyId: 'BRL',
    model: 'shopee_item',
    accountLabel: `Shopee ${shopId}`,
    // A Shopee não expõe "conta de teste" confirmada: a trava de publicação
    // real usa uma liberação própria (SHOPEE_LISTINGS_ALLOW_PUBLISH).
    isTestAccount: false,
  }
}

async function shopContext(companyId: number, integrationId: number, deps: ShopeeChannelDeps): Promise<ShopeeShopContext> {
  const ch = await resolveShopeeChannel(companyId, integrationId, deps)
  return { integrationId: ch.integrationId, companyId, shopId: ch.shopId!, deps: deps.request }
}

export async function listShopeeCategories(companyId: number, integrationId: number, filter: { parentId?: number | null; q?: string | null } = {}, deps: ShopeeChannelDeps = {}): Promise<ShopeeCategory[]> {
  const all = await getCategories(await shopContext(companyId, integrationId, deps))
  const q = filter.q?.trim().toLowerCase()
  return all.filter((c) =>
    (filter.parentId === undefined || (filter.parentId === null ? c.parent_category_id === null : c.parent_category_id === filter.parentId))
    && (!q || c.name.toLowerCase().includes(q) || c.original_name.toLowerCase().includes(q)))
}

export async function getShopeeCategoryAttributes(companyId: number, integrationId: number, categoryId: number, deps: ShopeeChannelDeps = {}): Promise<{ category: ReturnType<typeof findCategory>; attributes: ShopeeAttributeDefinition[] }> {
  const ctx = await shopContext(companyId, integrationId, deps)
  const category = findCategory(await getCategories(ctx), categoryId)
  if (!category.is_leaf) throw new ListingError('missing_attributes', 'Escolha uma categoria final (sem subcategorias).')
  return { category, attributes: await getCategoryAttributes(ctx, categoryId) }
}

export async function getShopeeBrands(companyId: number, integrationId: number, categoryId: number, deps: ShopeeChannelDeps = {}): Promise<ShopeeBrandInfo> {
  return getBrandList(await shopContext(companyId, integrationId, deps), categoryId)
}

export async function getShopeeLogistics(companyId: number, integrationId: number, deps: ShopeeChannelDeps = {}): Promise<ShopeeLogisticsChannel[]> {
  return getLogisticsChannels(await shopContext(companyId, integrationId, deps))
}

/** Tudo que a Shopee exige para publicar nesta categoria/loja (consulta ao vivo). */
export async function getShopeePublishRequirements(companyId: number, integrationId: number, categoryId: number, deps: ShopeeChannelDeps = {}): Promise<ShopeePublishRequirements> {
  return toPublishRequirements(await loadRequirementsSnapshot(await shopContext(companyId, integrationId, deps), categoryId))
}
