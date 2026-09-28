// Edição manual de preço de atacado (variação) — só inclui no patch os
// campos realmente enviados no payload. `undefined` nunca sobrescreve o
// valor atual da coluna; `null` é sempre intencional (limpar override e
// voltar a herdar do produto-pai). Mesma regra de merge parcial já usada
// para os demais campos opcionais desta rota (ncm/cest/origem/wholesale_price).
const PHYSICAL_OVERRIDES = ['weight_kg_override', 'package_length_cm_override', 'package_width_cm_override', 'package_height_cm_override'] as const

export interface VariationOverrideUpdateInput {
  price_override?: number | null
  wholesale_price_override?: number | null
  weight_kg_override?: number | null
  package_length_cm_override?: number | null
  package_width_cm_override?: number | null
  package_height_cm_override?: number | null
}

export type VariationOverridePatch = VariationOverrideUpdateInput

export function buildVariationOverridePatch(input: VariationOverrideUpdateInput): VariationOverridePatch {
  const patch: VariationOverridePatch = {}
  if (input.price_override !== undefined) patch.price_override = input.price_override
  if (input.wholesale_price_override !== undefined) patch.wholesale_price_override = input.wholesale_price_override
  for (const k of PHYSICAL_OVERRIDES) if (input[k] !== undefined) patch[k] = input[k]
  return patch
}
