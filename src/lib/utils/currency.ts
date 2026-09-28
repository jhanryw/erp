/**
 * Utilitários de formatação monetária e numérica
 */

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value)
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value)
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export function calcMargin(price: number, cost: number): number {
  if (price <= 0) return 0
  return ((price - cost) / price) * 100
}

export function calcMarkup(price: number, cost: number): number {
  if (cost <= 0) return 0
  return ((price - cost) / cost) * 100
}

export type MoneyInputResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string }

/**
 * Converte o que o usuário digitou num campo de preço, sem falha silenciosa:
 *   ''                → { ok, value: null }   (campo vazio: "sem valor")
 *   '12,90' / '12.90' → 12.9
 *   '1.234,56'        → 1234.56 (milhar com ponto, padrão brasileiro)
 *   '0', '0,00', 'abc', '-5', '12,345' → { ok: false, error }
 * Aceita "R$" e espaços. Nunca devolve NaN, Infinity nem valor ≤ 0.
 */
export function parseMoneyInput(raw: string | null | undefined): MoneyInputResult {
  const text = (raw ?? '').replace(/R\$/gi, '').replace(/\s+/g, '')
  if (text === '') return { ok: true, value: null }

  let normalized: string | null = null
  if (/^\d+(\.\d{1,2})?$/.test(text)) normalized = text                                   // 12 | 12.9 | 12.90
  else if (/^\d+(,\d{1,2})?$/.test(text)) normalized = text.replace(',', '.')             // 12,9 | 12,90
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) normalized = text.replace(/\./g, '').replace(',', '.') // 1.234,56

  if (normalized === null) {
    return { ok: false, error: `Valor inválido: "${(raw ?? '').trim()}". Use, por exemplo, 12,90.` }
  }
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'O valor precisa ser maior que zero.' }
  }
  return { ok: true, value: Math.round(value * 100) / 100 }
}

export function parseLocaleCurrency(value: string): number {
  // Converte "1.234,56" para 1234.56
  return parseFloat(value.replace(/\./g, '').replace(',', '.')) || 0
}
