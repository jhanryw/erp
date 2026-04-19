import { format, formatDistanceToNow, parseISO, isValid, subDays } from 'date-fns'
import { ptBR } from 'date-fns/locale'

// Sistema opera no fuso horário fixo do Brasil (Fortaleza = UTC-3, sem DST).
const BRAZIL_TZ = 'America/Fortaleza'

/**
 * Retorna a data atual (ou a data fornecida) como 'yyyy-MM-dd' no fuso
 * America/Fortaleza, independente do timezone do servidor/container.
 */
export function brazilDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BRAZIL_TZ }).format(date)
}

/**
 * Subtrai `days` dias da data atual e retorna como 'yyyy-MM-dd' no fuso brasileiro.
 */
export function brazilSubDays(days: number): string {
  return brazilDate(subDays(new Date(), days))
}

export function formatDate(date: string | Date, pattern = 'dd/MM/yyyy'): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return '—'
  return format(d, pattern, { locale: ptBR })
}

export function formatDateTime(date: string | Date): string {
  return formatDate(date, "dd/MM/yyyy 'às' HH:mm")
}

export function formatRelative(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return '—'
  return formatDistanceToNow(d, { addSuffix: true, locale: ptBR })
}

export function formatMonthYear(date: string | Date): string {
  return formatDate(date, 'MMMM yyyy')
}

export function toISODate(date: Date): string {
  return brazilDate(date)
}
