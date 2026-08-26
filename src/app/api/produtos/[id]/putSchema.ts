import { z } from 'zod'
import { ncmFieldSchema, cestFieldSchema, origemFieldSchema, wholesalePriceFieldSchema } from '@/lib/validators'

// Extraído de route.ts para ser testável em isolamento (sem mockar o
// handler PUT inteiro) — ver putSchema.test.ts.

export const variantToAddSchema = z.object({
  // sku_variation AUSENTE INTENCIONALMENTE: gerado no servidor via generateSKU()
  // Nunca aceito do cliente — mesma regra do POST /api/produtos
  color_value_id: z.number().int().positive().nullable().optional(),
  size_value_id: z.number().int().positive().nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override: z.coerce.number().min(0).nullable().optional(),
  // Fundação varejo/atacado (2026-08-31) — espelha price_override.
  wholesale_price_override: z.coerce.number().positive().nullable().optional(),
})

// Edição de override de variação JÁ EXISTENTE (preço varejo/atacado
// específicos) — distinto de variantToAddSchema (cria variação nova).
// Ambos os campos opcionais: só o que o cliente enviar é alterado
// (ver buildVariationOverridePatch). null limpa o override (volta a
// herdar do produto-pai); undefined mantém o valor atual no banco.
export const variantToUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  price_override: z.coerce.number().positive().nullable().optional(),
  wholesale_price_override: z.coerce.number().positive().nullable().optional(),
})

// Todos os campos do produto são opcionais — suporta update parcial.
// Campos ausentes no payload são preenchidos com o valor atual do banco (merge).
// A unicidade obrigatória é product_variations.sku_variation, não products.sku.
//
// .partial() no objeto INTEIRO (não só `.optional()` por campo) é
// obrigatório para os campos com z.preprocess() (ncm/cest/origem/
// wholesale_price, via ncmFieldSchema()/cestFieldSchema()/
// origemFieldSchema()/wholesalePriceFieldSchema()): sem isso, uma chave
// AUSENTE do payload (nunca enviada) ainda passa pelo preprocess — que
// trata `undefined` igual a `''` e vira `null` — e o merge parcial em
// route.ts (`patch.X !== undefined ? patch.X : snap.X`) então apaga um
// campo que o usuário nunca tocou. `.partial()` envolve cada campo em
// ZodOptional, que verifica "chave ausente" ANTES de chamar o preprocess
// interno — chave ausente fica `undefined` de verdade; só uma chave
// PRESENTE com `''`/`null` chega ao preprocess e vira `null` (limpeza
// intencional). Idempotente pros campos que já eram `.optional()`
// individualmente — nenhuma validação existente muda de comportamento.
// Ver putSchema.test.ts para a regressão desse bug.
export const putSchema = z.object({
  name: z.string().min(2).optional(),
  // SKU é texto livre — aceita letras, números, hífen, zeros à esquerda e
  // qualquer tamanho (mesma regra do cadastro manual em productSchema).
  // Nunca converter para número em nenhum ponto deste fluxo: SKUs como
  // "09", "722-G2" ou "ST-722-09" são válidos e não devem virar 9/722.
  sku: z.string().min(2, 'SKU obrigatório').max(50).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  brand_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']).optional(),
  base_cost: z.coerce.number().min(0).optional(),
  base_price: z.coerce.number().positive().optional(),
  active: z.boolean().optional(),
  variations_to_delete: z.array(z.number().int().positive()).optional(),
  variations_to_add: z.array(variantToAddSchema).optional(),
  // Edição manual de preço de atacado/varejo específico em variações
  // existentes (não passa por delete+add — preserva o mesmo id/histórico).
  variations_to_update: z.array(variantToUpdateSchema).optional(),
  ncm: ncmFieldSchema(),
  cest: cestFieldSchema(),
  origem: origemFieldSchema(),
  unidade_med: z.string().max(10).optional(),
  // Fundação varejo/atacado (2026-08-31).
  wholesale_price: wholesalePriceFieldSchema(),
}).partial()
