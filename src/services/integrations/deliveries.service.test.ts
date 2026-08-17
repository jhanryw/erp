import { describe, it, expect } from 'vitest'
import { computeNextAvailableAt, DELIVERY_BACKOFF_MINUTES, DELIVERY_MAX_ATTEMPTS } from './deliveries.service'

describe('computeNextAvailableAt — backoff fixo e previsível (seção 32 do pedido)', () => {
  const now = new Date('2026-08-16T12:00:00Z').getTime()

  it('tentativa 1 → +1min', () => {
    const result = computeNextAvailableAt(1, now)
    expect(result.getTime() - now).toBe(1 * 60_000)
  })

  it('tentativa 2 → +5min', () => {
    const result = computeNextAvailableAt(2, now)
    expect(result.getTime() - now).toBe(5 * 60_000)
  })

  it('tentativa 3 → +15min', () => {
    const result = computeNextAvailableAt(3, now)
    expect(result.getTime() - now).toBe(15 * 60_000)
  })

  it('tentativa 4 → +1h', () => {
    const result = computeNextAvailableAt(4, now)
    expect(result.getTime() - now).toBe(60 * 60_000)
  })

  it('tentativa além do schedule usa o último valor (nunca lança/estoura índice)', () => {
    const result = computeNextAvailableAt(99, now)
    expect(result.getTime() - now).toBe(60 * 60_000)
  })

  it('DELIVERY_MAX_ATTEMPTS é 1 a mais que o tamanho do schedule (a 5ª falha vai pra dead, sem mais retry agendado)', () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(DELIVERY_BACKOFF_MINUTES.length + 1)
    expect(DELIVERY_MAX_ATTEMPTS).toBe(5)
  })
})
