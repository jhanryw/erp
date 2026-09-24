import { z } from 'zod'

// Nenhum company_id / integration_id / listing de outro tenant vem do
// cliente: empresa e conta são SEMPRE resolvidas pela sessão no servidor.

const attributeValue = z.object({
  id: z.string().trim().min(1).max(80),
  value_id: z.string().trim().max(80).nullable().optional(),
  value_name: z.string().trim().max(255).nullable().optional(),
})

export const publishListingsSchema = z.object({
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

export type PublishListingsBody = z.infer<typeof publishListingsSchema>
