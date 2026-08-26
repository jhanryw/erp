import { describe, it, expect } from 'vitest'
import { resolveConsumidorFinal } from './consumidorFinal'

describe('resolveConsumidorFinal', () => {
  it('devolve 1 (consumidor final) quando o destinatário não tem CNPJ', () => {
    expect(resolveConsumidorFinal(null)).toBe(1)
    expect(resolveConsumidorFinal(undefined)).toBe(1)
    expect(resolveConsumidorFinal('')).toBe(1)
  })

  it('devolve 0 (não é consumidor final) quando o destinatário tem CNPJ', () => {
    expect(resolveConsumidorFinal('12345678000199')).toBe(0)
  })

  it('não depende de sale_type — a mesma função serve pra venda retail ou wholesale', () => {
    // Uma venda de atacado pra pessoa física continua consumidor final.
    expect(resolveConsumidorFinal(null)).toBe(1)
    // Uma venda de varejo pra uma empresa (CNPJ) não é consumidor final.
    expect(resolveConsumidorFinal('12345678000199')).toBe(0)
  })
})
