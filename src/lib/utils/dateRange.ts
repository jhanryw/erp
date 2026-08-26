/**
 * Resolução de período (presets + custom) — extraído de
 * `src/app/(dashboard)/page.tsx` nesta fase (Analytics Varejo/Atacado) pra
 * ser reutilizado pelo novo relatório `/relatorios/varejo-atacado` sem
 * duplicar a lógica ("não crie segunda infraestrutura de datas" — pedido
 * explícito). Extração pura — nenhuma mudança de comportamento; o
 * dashboard principal passou a importar esta função em vez de defini-la
 * localmente.
 */

import { brazilDate, brazilSubDays } from '@/lib/utils/date'
import type { RangePreset } from '@/components/modules/dashboards/date-range-picker'

export interface ResolvedDateRange {
  dateFrom: string
  dateTo: string
  activeRange: RangePreset | 'custom'
  rangeLabel: string
}

export function resolveDateRange(range?: string, from?: string, to?: string): ResolvedDateRange {
  const today = brazilDate()

  if (range === 'today') {
    return { dateFrom: today, dateTo: today, activeRange: 'today', rangeLabel: 'Hoje' }
  }
  if (range === 'yesterday') {
    const y = brazilSubDays(1)
    return { dateFrom: y, dateTo: y, activeRange: 'yesterday', rangeLabel: 'Ontem' }
  }
  if (range === '7d') {
    return { dateFrom: brazilSubDays(6), dateTo: today, activeRange: '7d', rangeLabel: 'Últimos 7 dias' }
  }
  if (range === 'month') {
    const [year, month] = today.split('-')
    return { dateFrom: `${year}-${month}-01`, dateTo: today, activeRange: 'month', rangeLabel: 'Este mês' }
  }
  if (range === '90d') {
    return { dateFrom: brazilSubDays(89), dateTo: today, activeRange: '90d', rangeLabel: 'Últimos 90 dias' }
  }
  if (range === 'year') {
    const year = today.substring(0, 4)
    return { dateFrom: `${year}-01-01`, dateTo: today, activeRange: 'year', rangeLabel: `Ano ${year}` }
  }
  if (range === 'custom' && from && to && from <= to) {
    const [fy, fm, fd] = from.split('-')
    const [ty, tm, td] = to.split('-')
    return {
      dateFrom: from,
      dateTo: to,
      activeRange: 'custom',
      rangeLabel: `${fd}/${fm}/${fy} – ${td}/${tm}/${ty}`,
    }
  }

  // Default: últimos 30 dias
  return { dateFrom: brazilSubDays(29), dateTo: today, activeRange: '30d', rangeLabel: 'Últimos 30 dias' }
}
