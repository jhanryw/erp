/**
 * Dados físicos de envio (peso/dimensões da embalagem) — regra ÚNICA de
 * resolução produto → override da variação. Genérica: usada pelo Marketplace
 * Hub (Shopee hoje) e reutilizável por Nuvemshop/ML/frete. Nada de canal aqui.
 *
 * Regra por campo (independente): variação preenchida → produto → ausente.
 * Ausente é null (nunca 0 fictício). Valor <= 0 / não finito é tratado como
 * INVÁLIDO (vira issue e o valor efetivo fica null) — o banco já barra via
 * CHECK, isto é a segunda linha de defesa para dados legados/fontes externas.
 */

export type ShippingValueSource = 'variation' | 'product' | 'none'

export interface ProductShippingFields {
  weight_kg?: number | string | null
  package_length_cm?: number | string | null
  package_width_cm?: number | string | null
  package_height_cm?: number | string | null
}

export interface VariationShippingOverrides {
  weight_kg_override?: number | string | null
  package_length_cm_override?: number | string | null
  package_width_cm_override?: number | string | null
  package_height_cm_override?: number | string | null
}

export type ShippingField = 'weightKg' | 'lengthCm' | 'widthCm' | 'heightCm'

export interface ResolvedShippingDimensions {
  weightKg: number | null
  lengthCm: number | null
  widthCm: number | null
  heightCm: number | null
  source: Record<ShippingField, ShippingValueSource>
  /** true quando as 3 dimensões estão presentes. */
  dimensionsComplete: boolean
  /** true quando só parte das 3 dimensões está presente (bloqueio nos canais). */
  dimensionsPartial: boolean
  issues: Array<{ field: ShippingField; source: 'variation' | 'product'; reason: 'non_positive' | 'not_a_number' }>
}

function parse(v: number | string | null | undefined): { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'bad'; reason: 'non_positive' | 'not_a_number' } {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return { kind: 'empty' }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return { kind: 'bad', reason: 'not_a_number' }
  if (n <= 0) return { kind: 'bad', reason: 'non_positive' }
  return { kind: 'ok', value: n }
}

export function resolveProductShippingDimensions(
  product: ProductShippingFields | null | undefined,
  variation: VariationShippingOverrides | null | undefined,
): ResolvedShippingDimensions {
  const issues: ResolvedShippingDimensions['issues'] = []
  const pick = (field: ShippingField, varValue: unknown, prodValue: unknown): { value: number | null; source: ShippingValueSource } => {
    const v = parse(varValue as number | string | null | undefined)
    if (v.kind === 'ok') return { value: v.value, source: 'variation' }
    if (v.kind === 'bad') { issues.push({ field, source: 'variation', reason: v.reason }); return { value: null, source: 'none' } }
    const p = parse(prodValue as number | string | null | undefined)
    if (p.kind === 'ok') return { value: p.value, source: 'product' }
    if (p.kind === 'bad') issues.push({ field, source: 'product', reason: p.reason })
    return { value: null, source: 'none' }
  }
  const w = pick('weightKg', variation?.weight_kg_override, product?.weight_kg)
  const l = pick('lengthCm', variation?.package_length_cm_override, product?.package_length_cm)
  const wd = pick('widthCm', variation?.package_width_cm_override, product?.package_width_cm)
  const h = pick('heightCm', variation?.package_height_cm_override, product?.package_height_cm)
  const present = [l.value, wd.value, h.value].filter((x) => x != null).length
  return {
    weightKg: w.value,
    lengthCm: l.value,
    widthCm: wd.value,
    heightCm: h.value,
    source: { weightKg: w.source, lengthCm: l.source, widthCm: wd.source, heightCm: h.source },
    dimensionsComplete: present === 3,
    dimensionsPartial: present > 0 && present < 3,
    issues,
  }
}
