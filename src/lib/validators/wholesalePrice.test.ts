import { describe, it, expect } from 'vitest'
import { productSchema, productEditSchema, wholesalePriceFieldSchema } from './index'

// Cobertura da edição manual de preço de atacado (produto + formulário de
// edição) — os mesmos campos usados pelo CSV (import-parser.ts) e lidos
// pelo PDV/site (resolveSalePrice.ts). Não testa o resto de productSchema
// (já implícito nos testes de cada consumidor).

describe('wholesalePriceFieldSchema', () => {
  it('aceita decimal', () => {
    expect(wholesalePriceFieldSchema().parse(49.9)).toBe(49.9)
    expect(wholesalePriceFieldSchema().parse('49.9')).toBe(49.9)
  })

  it('vazio/null/undefined vira null — nunca 0 (campo opcional, sem preço de atacado)', () => {
    expect(wholesalePriceFieldSchema().parse('')).toBeNull()
    expect(wholesalePriceFieldSchema().parse(null)).toBeNull()
    expect(wholesalePriceFieldSchema().parse(undefined)).toBeNull()
  })

  it('rejeita negativo', () => {
    expect(() => wholesalePriceFieldSchema().parse(-10)).toThrow()
  })

  it('rejeita zero (mesma regra de base_price — preço precisa ser > 0 quando informado)', () => {
    expect(() => wholesalePriceFieldSchema().parse(0)).toThrow()
  })

  it('rejeita string inválida/NaN', () => {
    expect(() => wholesalePriceFieldSchema().parse('abc')).toThrow()
  })
})

describe('productSchema.wholesale_price (cadastro novo)', () => {
  const base = {
    name: 'Body de Renda', sku: 'BODY-001', category_id: 1, origin: 'third_party' as const,
    base_cost: 20, base_price: 50, unidade_med: 'UN',
  }

  it('produto criado COM preço de atacado', () => {
    const parsed = productSchema.parse({ ...base, wholesale_price: 35 })
    expect(parsed.wholesale_price).toBe(35)
    expect(parsed.base_price).toBe(50) // varejo intacto
  })

  it('produto criado SEM preço de atacado — válido, wholesale_price null', () => {
    const parsed = productSchema.parse({ ...base, wholesale_price: '' })
    expect(parsed.wholesale_price).toBeNull()
    expect(parsed.base_price).toBe(50)
  })

  it('negativo rejeitado no cadastro', () => {
    expect(() => productSchema.parse({ ...base, wholesale_price: -5 })).toThrow()
  })
})

describe('productEditSchema.wholesale_price (edição)', () => {
  it('editar preço de atacado não altera o preço de varejo (campos independentes)', () => {
    const parsed = productEditSchema.parse({ wholesale_price: 42.5 })
    expect(parsed.wholesale_price).toBe(42.5)
    expect(parsed.base_price).toBeUndefined() // não enviado → merge no backend preserva o valor atual
  })

  it('limpar preço de atacado (campo vazio) → null explícito, distinto de "não enviado"', () => {
    const parsed = productEditSchema.parse({ wholesale_price: '' })
    expect(parsed.wholesale_price).toBeNull()
    expect('wholesale_price' in parsed).toBe(true)
  })

  it('negativo rejeitado na edição', () => {
    expect(() => productEditSchema.parse({ wholesale_price: -1 })).toThrow()
  })

  // Não-óbvio: productEditSchema = productSchema.partial() — .partial() faz
  // cada campo virar ZodOptional, que retorna undefined SEM rodar o
  // preprocess quando a chave está totalmente ausente do payload. Se essa
  // garantia quebrasse (ex.: alguém tirasse o .partial() ou reestruturasse
  // o schema), toda edição que não mexe em wholesale_price passaria a
  // zerá-lo silenciosamente no PUT (merge usa `!== undefined` pra decidir
  // se sobrescreve — ver src/app/api/produtos/[id]/route.ts).
  it('wholesale_price OMITIDO do payload (não só vazio) — fica undefined, nunca vira null por conta própria', () => {
    const parsed = productEditSchema.parse({ name: 'Outro nome' })
    expect(parsed.wholesale_price).toBeUndefined()
    expect('wholesale_price' in parsed).toBe(false)
  })
})
