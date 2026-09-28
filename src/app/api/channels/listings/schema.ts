import { z } from 'zod'

// Nenhum company_id / integration_id / listing de outro tenant vem do
// cliente: empresa e conta são SEMPRE resolvidas pela sessão no servidor.

const attributeValue = z.object({
  id: z.string().trim().min(1).max(80),
  value_id: z.string().trim().max(80).nullable().optional(),
  value_name: z.string().trim().max(255).nullable().optional(),
})

export const mercadoLivrePublishSchema = z.object({
  provider: z.literal('mercadolivre'),
  product_id: z.coerce.number().int().positive(),
  category_id: z.string().trim().regex(/^[A-Z]{3}\d+$/, 'Categoria inválida.'),
  domain_id: z.string().trim().regex(/^([A-Z]{3}-)?[A-Z0-9_]{2,80}$/, 'Domínio inválido.').nullable().optional(),
  listing_type_id: z.string().trim().max(40).optional(),
  // Oferta dentro da variação (N anúncios por variação). Padrão = listing_type_id.
  offer_key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, 'Identificador da oferta inválido.').nullable().optional(),
  family_name: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(50000).nullable().optional(),
  common_attributes: z.array(attributeValue).max(200).default([]),
  variations: z.array(z.object({
    product_variation_id: z.coerce.number().int().positive(),
    channel_price: z.coerce.number().positive().nullable().optional(),
    attributes: z.array(attributeValue).max(100).default([]),
  })).min(1, 'Selecione ao menos uma variação.').max(100),
})

const positiveInt = z.coerce.number().int().positive()

/**
 * Shopee (Fase 3): produto SIMPLES — exatamente 1 variação vendável por
 * publicação. integration_id identifica QUAL loja (multi-loja); a empresa
 * vem da sessão e a integração é validada contra ela no servidor.
 * Peso/condição são opcionais AQUI de propósito: a validação do canal
 * devolve erros estruturados (missing_weight, missing_condition…).
 */
export const shopeePublishSchema = z.object({
  provider: z.literal('shopee'),
  integration_id: positiveInt,
  product_id: positiveInt,
  category_id: z.string().trim().regex(/^\d{1,12}$/, 'Categoria Shopee inválida.'),
  offer_key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, 'Identificador da oferta inválido.').nullable().optional(),
  item_name: z.string().trim().max(255).nullable().optional(),
  description: z.string().trim().max(50000).nullable().optional(),
  condition: z.string().trim().max(10).nullable().optional(),
  weight_kg: z.coerce.number().nullable().optional(),
  dimension: z.object({
    package_height: z.coerce.number().nullable().optional(),
    package_length: z.coerce.number().nullable().optional(),
    package_width: z.coerce.number().nullable().optional(),
  }).nullable().optional(),
  brand: z.union([
    z.object({ brand_id: z.coerce.number().int().nonnegative(), original_brand_name: z.string().trim().max(255) }),
    z.object({ no_brand: z.literal(true) }),
  ]).nullable().optional(),
  attributes: z.array(z.object({
    attribute_id: positiveInt,
    values: z.array(z.object({
      value_id: z.coerce.number().int().nonnegative(),
      original_value_name: z.string().trim().max(255).nullable().optional(),
      value_unit: z.string().trim().max(40).nullable().optional(),
    })).min(1).max(30),
  })).max(200).default([]),
  logistic_channel_id: positiveInt.nullable().optional(),
  item_status: z.enum(['NORMAL', 'UNLIST']).nullable().optional(),
  variations: z.array(z.object({
    product_variation_id: positiveInt,
    channel_price: z.coerce.number().positive().nullable().optional(),
  })).length(1, 'Shopee (fase atual): publique um produto simples — exatamente 1 variação.'),
})

export const publishListingsSchema = z.discriminatedUnion('provider', [mercadoLivrePublishSchema, shopeePublishSchema])

export type PublishListingsBody = z.infer<typeof publishListingsSchema>
export type ShopeePublishBody = z.infer<typeof shopeePublishSchema>
