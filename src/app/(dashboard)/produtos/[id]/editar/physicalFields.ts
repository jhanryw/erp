/**
 * Dados físicos de envio na tela de edição (produto + override por variação).
 * Pura e testável — ver physicalFields.test.ts.
 *
 * Regras: '' → null (produto: sem dado; variação: herda do produto);
 * peso aceita "0,35"/"0.35" (kg > 0); dimensões são cm inteiros > 0.
 * Inválido nunca vira null nem é enviado: vai para `errors`.
 * Só entra no payload o que mudou em relação ao carregado do banco.
 */

export const PHYSICAL_KEYS = ['weight_kg', 'package_length_cm', 'package_width_cm', 'package_height_cm'] as const
export type PhysicalKey = typeof PHYSICAL_KEYS[number]
export type PhysicalEdit = Record<PhysicalKey, string>

export const PHYSICAL_LABEL: Record<PhysicalKey, string> = {
  weight_kg: 'Peso (kg)',
  package_length_cm: 'Comprimento (cm)',
  package_width_cm: 'Largura (cm)',
  package_height_cm: 'Altura (cm)',
}

export const EMPTY_PHYSICAL: PhysicalEdit = { weight_kg: '', package_length_cm: '', package_width_cm: '', package_height_cm: '' }

type Parsed = { ok: true; value: number | null } | { ok: false; error: string }

export function parsePhysical(key: PhysicalKey, raw: string): Parsed {
  const s = (raw ?? '').trim().replace(',', '.')
  if (s === '') return { ok: true, value: null }
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'precisa ser maior que zero' }
  if (key !== 'weight_kg' && !Number.isInteger(n)) return { ok: false, error: 'use centímetros inteiros' }
  return { ok: true, value: key === 'weight_kg' ? Math.round(n * 1000) / 1000 : n }
}

export function physicalToEdit(src: Partial<Record<string, unknown>> | null | undefined, suffix = ''): PhysicalEdit {
  const out = { ...EMPTY_PHYSICAL }
  for (const k of PHYSICAL_KEYS) {
    const v = src?.[`${k}${suffix}`]
    out[k] = v != null && v !== '' ? String(Number(v)) : ''
  }
  return out
}

const same = (a: number | null, b: unknown) => (a == null ? b == null || b === '' : b != null && b !== '' && Math.abs(a - Number(b)) < 1e-9)

export interface PhysicalError { scope: string; key: PhysicalKey; message: string }

/** Patch do PRODUTO (chaves = colunas de products). */
export function buildProductPhysicalPatch(edit: PhysicalEdit, current: Partial<Record<string, unknown>> | null | undefined): { patch: Partial<Record<PhysicalKey, number | null>>; errors: PhysicalError[] } {
  const patch: Partial<Record<PhysicalKey, number | null>> = {}
  const errors: PhysicalError[] = []
  for (const k of PHYSICAL_KEYS) {
    const p = parsePhysical(k, edit[k])
    if (!p.ok) { errors.push({ scope: 'Produto', key: k, message: p.error }); continue }
    if (!same(p.value, current?.[k])) patch[k] = p.value
  }
  return { patch, errors }
}

/** Updates de variações existentes (chaves = <coluna>_override). */
export function buildVariationPhysicalUpdates(
  variations: Array<{ id: number; sku_variation: string } & Partial<Record<string, unknown>>>,
  edits: Record<number, PhysicalEdit>,
): { updates: Array<{ id: number } & Partial<Record<`${PhysicalKey}_override`, number | null>>>; errors: PhysicalError[] } {
  const updates: Array<{ id: number } & Partial<Record<`${PhysicalKey}_override`, number | null>>> = []
  const errors: PhysicalError[] = []
  for (const v of variations) {
    const edit = edits[v.id]
    if (!edit) continue
    const upd: { id: number } & Partial<Record<`${PhysicalKey}_override`, number | null>> = { id: v.id }
    let changed = false
    for (const k of PHYSICAL_KEYS) {
      const p = parsePhysical(k, edit[k])
      if (!p.ok) { errors.push({ scope: v.sku_variation, key: k, message: p.error }); continue }
      if (!same(p.value, v[`${k}_override`])) { upd[`${k}_override`] = p.value; changed = true }
    }
    if (changed) updates.push(upd)
  }
  return { updates, errors }
}

export function describePhysicalError(e: PhysicalError): string {
  return `${e.scope} · ${PHYSICAL_LABEL[e.key]}: ${e.message}`
}
