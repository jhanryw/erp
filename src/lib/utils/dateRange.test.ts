import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveDateRange } from './dateRange'

// `brazilDate()` usa `new Date()` internamente (fuso fixo America/Fortaleza,
// UTC-3, sem DST) — fake timers em UTC reproduzem exatamente a mesma data
// de calendário que o fuso brasileiro veria, sem precisar mockar o módulo.
function setNow(isoUtc: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(isoUtc))
}

describe('resolveDateRange', () => {
  afterEach(() => vi.useRealTimers())

  describe('preset "month" — Este mês (mês calendário atual)', () => {
    it('26/08/2026 → início 01/08/2026, fim hoje (exemplo do pedido)', () => {
      setNow('2026-08-26T12:00:00Z')
      const result = resolveDateRange('month')
      expect(result).toEqual({
        dateFrom: '2026-08-01',
        dateTo: '2026-08-26',
        activeRange: 'month',
        rangeLabel: 'Este mês',
      })
    })

    it('primeiro dia do mês → início e fim são o mesmo dia', () => {
      setNow('2026-09-01T09:00:00Z')
      const result = resolveDateRange('month')
      expect(result.dateFrom).toBe('2026-09-01')
      expect(result.dateTo).toBe('2026-09-01')
    })

    it('último dia do mês → cobre o mês inteiro até hoje', () => {
      setNow('2026-02-28T23:00:00Z')
      const result = resolveDateRange('month')
      expect(result.dateFrom).toBe('2026-02-01')
      expect(result.dateTo).toBe('2026-02-28')
    })

    it('é diferente de "30d" quando o mês corrente tem menos de 30 dias decorridos', () => {
      setNow('2026-08-10T12:00:00Z') // dia 10 → mês calendário tem só 10 dias, 30d teria 30
      const month = resolveDateRange('month')
      const thirtyDays = resolveDateRange('30d')
      expect(month.dateFrom).toBe('2026-08-01')
      expect(thirtyDays.dateFrom).not.toBe(month.dateFrom)
      expect(thirtyDays.dateFrom).toBe('2026-07-12') // 29 dias atrás de 10/08
    })

    it('respeita o fuso brasileiro fixo — mesma regra dos outros presets, nunca UTC puro', () => {
      // 01/09/2026 00:30 UTC ainda é 31/08/2026 21:30 em America/Fortaleza (UTC-3)
      setNow('2026-09-01T00:30:00Z')
      const result = resolveDateRange('month')
      expect(result.dateFrom).toBe('2026-08-01')
      expect(result.dateTo).toBe('2026-08-31')
    })
  })

  describe('presets existentes — comportamento inalterado', () => {
    beforeEach(() => setNow('2026-08-26T12:00:00Z'))

    it('today', () => {
      expect(resolveDateRange('today')).toEqual({
        dateFrom: '2026-08-26', dateTo: '2026-08-26', activeRange: 'today', rangeLabel: 'Hoje',
      })
    })

    it('yesterday', () => {
      expect(resolveDateRange('yesterday')).toEqual({
        dateFrom: '2026-08-25', dateTo: '2026-08-25', activeRange: 'yesterday', rangeLabel: 'Ontem',
      })
    })

    it('7d', () => {
      expect(resolveDateRange('7d')).toEqual({
        dateFrom: '2026-08-20', dateTo: '2026-08-26', activeRange: '7d', rangeLabel: 'Últimos 7 dias',
      })
    })

    it('30d (default e explícito) — continua representando os últimos 30 dias, não o mês calendário', () => {
      const explicit = resolveDateRange('30d')
      const fallback = resolveDateRange(undefined)
      expect(explicit).toEqual({
        dateFrom: '2026-07-28', dateTo: '2026-08-26', activeRange: '30d', rangeLabel: 'Últimos 30 dias',
      })
      expect(fallback).toEqual(explicit)
    })

    it('90d', () => {
      expect(resolveDateRange('90d')).toEqual({
        dateFrom: '2026-05-29', dateTo: '2026-08-26', activeRange: '90d', rangeLabel: 'Últimos 90 dias',
      })
    })

    it('year', () => {
      expect(resolveDateRange('year')).toEqual({
        dateFrom: '2026-01-01', dateTo: '2026-08-26', activeRange: 'year', rangeLabel: 'Ano 2026',
      })
    })

    it('custom', () => {
      expect(resolveDateRange('custom', '2026-08-01', '2026-08-15')).toEqual({
        dateFrom: '2026-08-01', dateTo: '2026-08-15', activeRange: 'custom', rangeLabel: '01/08/2026 – 15/08/2026',
      })
    })

    it('custom com from > to cai no default (30d) — mesma regra de antes', () => {
      expect(resolveDateRange('custom', '2026-08-15', '2026-08-01').activeRange).toBe('30d')
    })
  })
})
