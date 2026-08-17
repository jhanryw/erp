import { describe, it, expect } from 'vitest'
import { buildOutboxEventId } from './outbox.service'

describe('buildOutboxEventId — helper canônico, nunca concatenar manualmente', () => {
  it('sale.completed vira sale:<id>:completed', () => {
    expect(buildOutboxEventId('sale', 123, 'sale.completed')).toBe('sale:123:completed')
  })

  it('sale.cancelled vira sale:<id>:cancelled', () => {
    expect(buildOutboxEventId('sale', 123, 'sale.cancelled')).toBe('sale:123:cancelled')
  })

  it('sale.refunded vira sale:<id>:refunded (mesmo formato usado por rpc_return_sale e rpc_process_exchange)', () => {
    expect(buildOutboxEventId('sale', 456, 'sale.refunded')).toBe('sale:456:refunded')
  })

  it('aceita aggregateId como string', () => {
    expect(buildOutboxEventId('sale', '789', 'sale.completed')).toBe('sale:789:completed')
  })

  it('mesmo aggregate + evento sempre produz o mesmo event_id (determinístico)', () => {
    const a = buildOutboxEventId('sale', 1, 'sale.completed')
    const b = buildOutboxEventId('sale', 1, 'sale.completed')
    expect(a).toBe(b)
  })

  it('aggregates diferentes nunca colidem', () => {
    expect(buildOutboxEventId('sale', 1, 'sale.completed')).not.toBe(buildOutboxEventId('sale', 2, 'sale.completed'))
  })
})
