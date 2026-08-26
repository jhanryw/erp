import { describe, it, expect } from 'vitest'
import { customerSchema, productSchema } from './index'

describe('customerSchema — fundação varejo/atacado (CPF opcional)', () => {
  it('aceita cliente sem CPF (ausente)', () => {
    const result = customerSchema.safeParse({ name: 'Cliente Sem CPF', phone: '84999990000' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.cpf).toBeNull()
  })

  it('aceita cliente com CPF vazio/null — normaliza para null', () => {
    const result = customerSchema.safeParse({ name: 'Cliente CPF Vazio', phone: '84999990000', cpf: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.cpf).toBeNull()
  })

  it('continua aceitando CPF válido quando informado', () => {
    // CPF válido (dígitos verificadores corretos) usado em testes do projeto.
    const result = customerSchema.safeParse({ name: 'Cliente Com CPF', phone: '84999990000', cpf: '11144477735' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.cpf).toBe('11144477735')
  })

  it('continua rejeitando CPF malformado (dígito verificador inválido) quando informado', () => {
    const result = customerSchema.safeParse({ name: 'Cliente CPF Ruim', phone: '84999990000', cpf: '11111111111' })
    expect(result.success).toBe(false)
  })
})

describe('productSchema — fundação varejo/atacado (wholesale_price)', () => {
  const base = {
    name: 'Produto Teste', sku: 'TESTE-0001', category_id: 1, origin: 'third_party' as const,
    base_cost: 10, base_price: 50,
  }

  it('produto sem wholesale_price continua válido (opcional)', () => {
    const result = productSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.wholesale_price).toBeNull()
  })

  it('aceita wholesale_price positivo', () => {
    const result = productSchema.safeParse({ ...base, wholesale_price: 35 })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.wholesale_price).toBe(35)
  })

  it('rejeita wholesale_price <= 0 quando informado', () => {
    const result = productSchema.safeParse({ ...base, wholesale_price: 0 })
    expect(result.success).toBe(false)
  })
})
