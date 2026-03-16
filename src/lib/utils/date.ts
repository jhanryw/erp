import { format, formatDistanceToNow, parseISO, isValid } from 'date-fns'
import { ptBR } from 'date-fns/locale'

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
  return format(date, 'yyyy-MM-dd')
}
