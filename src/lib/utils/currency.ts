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

export function parseLocaleCurrency(value: string): number {
  // Converte "1.234,56" para 1234.56
  return parseFloat(value.replace(/\./g, '').replace(',', '.')) || 0
}
