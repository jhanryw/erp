/**
 * O que a Shopee exige para publicar um item SIMPLES numa categoria desta
 * loja — consultado ao vivo (categoria, atributos, marcas, logística).
 * Base da Fase 3 (validateListing) e, depois, da UI de publicação.
 */

import { ShopeeError } from './errors'
import type { ShopeeShopContext } from './client'
import {
  findCategory,
  getBrandList,
  getCategories,
  getCategoryAttributes,
  getLogisticsChannels,
  usableLogisticsChannels,
  type ShopeeAttributeDefinition,
  type ShopeeBrand,
  type ShopeeCategoryDetails,
  type ShopeeLogisticsChannel,
} from './catalog'
import { SHOPEE_CONDITIONS, type ShopeeRequirementsSnapshot } from './listingPayload'

export interface ShopeePublishRequirements {
  category: ShopeeCategoryDetails
  attributes: {
    required: ShopeeAttributeDefinition[]
    optional: ShopeeAttributeDefinition[]
  }
  brand: {
    required: boolean
    options: ShopeeBrand[]
    /** "Sem marca" só quando a própria API oferece a entrada "No Brand". */
    no_brand_option: ShopeeBrand | null
    truncated: boolean
  }
  weight: { required: true; unit: 'kg'; source: 'publish_input' }
  dimensions: { required: false; unit: 'cm'; all_or_none: true; fields: ['package_height', 'package_length', 'package_width'] }
  condition: { required: true; values: readonly string[]; source: string }
  logistics: {
    channels: ShopeeLogisticsChannel[]
    usable: ShopeeLogisticsChannel[]
    default_channel_id: number | null
  }
  images: { required: true; formats: ['jpg', 'jpeg', 'png']; max_bytes: number; source: 'media_hub' }
}

export async function loadRequirementsSnapshot(ctx: ShopeeShopContext, categoryId: number): Promise<ShopeeRequirementsSnapshot> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) throw new ShopeeError('bad_request', 'Categoria Shopee inválida.')
  const category = findCategory(await getCategories(ctx), categoryId)
  if (!category.is_leaf) {
    // Não consulta atributos/marcas de categoria intermediária.
    return { category, attributes: [], brand: { is_mandatory: false, input_type: null, brands: [], no_brand_option: null, truncated: false }, logistics: await getLogisticsChannels(ctx) }
  }
  const [attributes, brand, logistics] = await Promise.all([
    getCategoryAttributes(ctx, categoryId),
    getBrandList(ctx, categoryId),
    getLogisticsChannels(ctx),
  ])
  return { category, attributes, brand, logistics }
}

export function toPublishRequirements(snap: ShopeeRequirementsSnapshot): ShopeePublishRequirements {
  const usable = usableLogisticsChannels(snap.logistics)
  return {
    category: snap.category,
    attributes: {
      required: snap.attributes.filter((a) => a.mandatory),
      optional: snap.attributes.filter((a) => !a.mandatory),
    },
    brand: {
      required: snap.brand.is_mandatory,
      options: snap.brand.brands,
      no_brand_option: snap.brand.no_brand_option,
      truncated: snap.brand.truncated,
    },
    weight: { required: true, unit: 'kg', source: 'publish_input' },
    dimensions: { required: false, unit: 'cm', all_or_none: true, fields: ['package_height', 'package_length', 'package_width'] },
    condition: { required: true, values: SHOPEE_CONDITIONS, source: 'v2.product.add_item (Update Log 2026-09-01: "Condition is required for BR")' },
    logistics: { channels: snap.logistics, usable, default_channel_id: usable[0]?.logistics_channel_id ?? null },
    images: { required: true, formats: ['jpg', 'jpeg', 'png'], max_bytes: 10 * 1024 * 1024, source: 'media_hub' },
  }
}
