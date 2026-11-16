/**
 * Data/hora de emissão no formato exigido pela Focus NFe para NF-e:
 * ISO 8601 com offset explícito, ex.: `2026-11-16T10:05:00-03:00`.
 *
 * Calculada SEMPRE no momento da montagem do payload (nunca fixa, nunca
 * vinda de dado de venda antigo) e no fuso do emitente. O offset é derivado
 * do fuso via Intl (nunca hardcoded), então continua correto se o Brasil
 * voltar a ter horário de verão.
 */

export const FISCAL_DEFAULT_TIMEZONE = 'America/Sao_Paulo'

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

export function formatFocusDateTime(date: Date = new Date(), timeZone: string = FISCAL_DEFAULT_TIMEZONE): string {
  if (Number.isNaN(date.getTime())) throw new Error('formatFocusDateTime: data inválida.')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const y = get('year'), mo = get('month'), d = get('day')
  const h = get('hour'), mi = get('minute'), s = get('second')

  // Offset = (hora local interpretada como UTC) − (instante real), em minutos.
  const localAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const instant = Math.floor(date.getTime() / 1000) * 1000
  const offsetMin = Math.round((localAsUtc - instant) / 60000)
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  const oh = String(Math.floor(abs / 60)).padStart(2, '0')
  const om = String(abs % 60).padStart(2, '0')

  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`
}

export function isValidFocusDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value))
}
