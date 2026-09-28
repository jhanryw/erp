import { parseMoneyInput } from '@/lib/utils/currency'

/**
 * Montagem de `variations_to_update` (preço varejo/atacado específicos de
 * variações EXISTENTES) a partir do que foi digitado na tela de edição.
 * Pura e testável — ver variationOverrides.test.ts.
 *
 * Regras:
 *   - só entra quem realmente mudou (comparação em centavos);
 *   - '' limpa o override (null) — só é mudança se havia valor;
 *   - valor inválido NUNCA vira null nem entra no payload: vai para `errors`
 *     e quem chama não deve enviar nada.
 */

export type OverrideEdit = { price_override: string; wholesale_price_override: string }

export interface OverrideSourceVariation {
  id: number
  sku_variation: string
  price_override: number | string | null
  wholesale_price_override: number | string | null
}

export interface VariationOverrideUpdate {
  id: number
  price_override: number | null
  wholesale_price_override: number | null
}

export interface VariationOverrideError {
  variationId: number
  sku: string
  field: 'price_override' | 'wholesale_price_override'
  message: string
}

const FIELD_LABEL: Record<VariationOverrideError['field'], string> = {
  price_override: 'Preço varejo específico',
  wholesale_price_override: 'Preço atacado específico',
}

function toCents(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function describeOverrideError(e: VariationOverrideError): string {
  return `${e.sku} · ${FIELD_LABEL[e.field]}: ${e.message}`
}

export function buildVariationOverrideUpdates(
  variations: OverrideSourceVariation[],
  edits: Record<number, OverrideEdit>,
): { updates: VariationOverrideUpdate[]; errors: VariationOverrideError[] } {
  const updates: VariationOverrideUpdate[] = []
  const errors: VariationOverrideError[] = []

  for (const v of variations) {
    const edit = edits[v.id]
    if (!edit) continue

    const price = parseMoneyInput(edit.price_override)
    const wholesale = parseMoneyInput(edit.wholesale_price_override)
    if (!price.ok) errors.push({ variationId: v.id, sku: v.sku_variation, field: 'price_override', message: price.error })
    if (!wholesale.ok) errors.push({ variationId: v.id, sku: v.sku_variation, field: 'wholesale_price_override', message: wholesale.error })
    if (!price.ok || !wholesale.ok) continue

    const priceChanged = toCents(price.value) !== toCents(v.price_override)
    const wholesaleChanged = toCents(wholesale.value) !== toCents(v.wholesale_price_override)
    if (!priceChanged && !wholesaleChanged) continue

    updates.push({ id: v.id, price_override: price.value, wholesale_price_override: wholesale.value })
  }

  return { updates, errors }
}
