import { z } from 'zod'
import { ncmFieldSchema, cestFieldSchema, origemFieldSchema, wholesalePriceFieldSchema } from '@/lib/validators'

// Extraído de route.ts para ser testável em isolamento — ver schema.test.ts.
// Nenhum campo de empresa aqui: company_id sempre vem da sessão (RPC deriva
// de users.company_id do usuário autenticado).

export const kitComponentSchema = z.object({
  component_product_variation_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int('Quantidade precisa ser inteira.').positive('Quantidade precisa ser maior que zero.'),
})

export const kitComponentsSchema = z
  .array(kitComponentSchema)
  .min(1, 'O kit precisa ter pelo menos um componente.')
  .max(50, 'Um kit aceita no máximo 50 componentes.')

// SKU do kit é digitado (ex.: KIT-PB-M) — o gerador tipo/modelo/ano das
// variações standard não se aplica a produto composto. Texto livre, nunca
// convertido para número (mesma regra de putSchema.sku).
const skuSchema = z.string().trim().min(2, 'SKU obrigatório.').max(60, 'SKU com no máximo 60 caracteres.')

export const kitVariationSchema = z.object({
  sku_variation: skuSchema,
  price_override: z.coerce.number().positive().nullable().optional(),
  wholesale_price_override: z.coerce.number().positive().nullable().optional(),
  color_value_id: z.coerce.number().int().positive().nullable().optional(),
  size_value_id: z.coerce.number().int().positive().nullable().optional(),
  components: kitComponentsSchema,
})

export const createKitSchema = z.object({
  name: z.string().trim().min(2, 'Nome obrigatório.'),
  sku: skuSchema,
  category_id: z.coerce.number().int().positive(),
  brand_id: z.coerce.number().int().positive().nullable().optional(),
  base_price: z.coerce.number().positive('Preço do kit precisa ser maior que zero.'),
  wholesale_price: wholesalePriceFieldSchema(),
  active: z.boolean().default(true),
  ano: z.string().trim().max(10).nullable().optional(),
  ncm: ncmFieldSchema(),
  cest: cestFieldSchema(),
  origem: origemFieldSchema(),
  unidade_med: z.string().max(10).nullable().optional(),
  variations: z.array(kitVariationSchema).min(1, 'O kit precisa ter pelo menos uma variação vendável.').max(50),
}).superRefine((data, ctx) => {
  const skus = data.variations.map((v) => v.sku_variation.toUpperCase())
  if (new Set(skus).size !== skus.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variations'], message: 'SKUs de variação repetidos no mesmo kit.' })
  }
})

export const addKitVariationsSchema = z.object({
  variations: z.array(kitVariationSchema).min(1).max(50),
})

export const setKitComponentsSchema = z.object({
  components: kitComponentsSchema,
})

/** Achata o erro do Zod numa string (frontend espera string em `error`). */
export function zodErrorMessage(error: z.ZodError): string {
  const flat = error.flatten()
  return [
    ...flat.formErrors,
    ...Object.entries(flat.fieldErrors).flatMap(([field, msgs]) => (msgs ?? []).map((m) => `${field}: ${m}`)),
  ].join('; ') || 'Dados inválidos.'
}
