import { describe, it, expect } from 'vitest'
import { putSchema } from './putSchema'

// Regressão: PUT /api/produtos/[id] é um update PARCIAL — campo AUSENTE do
// payload nunca pode virar null (isso apagaria dado que o usuário não
// tocou). Só um campo PRESENTE no payload como '' (string vazia) pode virar
// null (limpeza intencional, ver src/lib/validators/index.ts). Bug real
// encontrado: ncm/cest/origem/wholesale_price usam z.preprocess(), que sem
// o `.partial()` no objeto inteiro convertia até chave AUSENTE em null.

describe('putSchema — semântica de PATCH parcial', () => {
  // ── 1-2: ncm ──────────────────────────────────────────────────────────────
  it('1. ncm omitido do payload → permanece undefined (nunca vira null)', () => {
    const parsed = putSchema.parse({ name: 'Produto X' })
    expect(parsed.ncm).toBeUndefined()
    expect('ncm' in parsed).toBe(false)
  })

  it('2. ncm enviado vazio explicitamente → vira null (limpeza intencional)', () => {
    const parsed = putSchema.parse({ ncm: '' })
    expect(parsed.ncm).toBeNull()
  })

  // ── 3-4: wholesale_price ─────────────────────────────────────────────────
  it('3. wholesale_price omitido do payload → permanece undefined (nunca vira null)', () => {
    const parsed = putSchema.parse({ name: 'Produto X' })
    expect(parsed.wholesale_price).toBeUndefined()
    expect('wholesale_price' in parsed).toBe(false)
  })

  it('4. wholesale_price enviado vazio explicitamente → vira null (limpa preço de atacado)', () => {
    const parsed = putSchema.parse({ wholesale_price: '' })
    expect(parsed.wholesale_price).toBeNull()
  })

  // ── 5-6: origem/cest ─────────────────────────────────────────────────────
  it('5. origem omitida do payload → permanece undefined', () => {
    const parsed = putSchema.parse({ name: 'Produto X' })
    expect(parsed.origem).toBeUndefined()
    expect('origem' in parsed).toBe(false)
  })

  it('6. cest omitido do payload → permanece undefined', () => {
    const parsed = putSchema.parse({ name: 'Produto X' })
    expect(parsed.cest).toBeUndefined()
    expect('cest' in parsed).toBe(false)
  })

  // ── 7: payload mínimo não vaza limpeza pra outros campos do produto ─────
  it('7. payload contendo apenas wholesale_price não limpa nenhum outro campo do produto', () => {
    const parsed = putSchema.parse({ wholesale_price: 42.5 })
    expect(parsed.wholesale_price).toBe(42.5)
    // Todos os demais campos do produto ficam undefined — o merge parcial em
    // route.ts (`patch.X !== undefined ? patch.X : snap.X`) preserva o valor
    // atual do banco para cada um destes.
    for (const key of ['name', 'sku', 'category_id', 'supplier_id', 'brand_id', 'origin', 'base_cost', 'base_price', 'active', 'ncm', 'cest', 'origem', 'unidade_med'] as const) {
      expect(parsed[key]).toBeUndefined()
    }
  })

  // ── 8: payload de override de variação não vaza limpeza pro produto ────
  it('8. payload contendo apenas variations_to_update não limpa campos do produto', () => {
    const parsed = putSchema.parse({
      variations_to_update: [{ id: 10, wholesale_price_override: 30 }],
    })
    expect(parsed.variations_to_update).toEqual([{ id: 10, wholesale_price_override: 30 }])
    for (const key of ['name', 'sku', 'base_price', 'wholesale_price', 'ncm', 'cest', 'origem'] as const) {
      expect(parsed[key]).toBeUndefined()
    }
  })

  // ── 9: valores inválidos continuam rejeitados (o .partial() não afrouxa validação) ──
  it('9a. ncm inválido (não 8 dígitos) continua rejeitado', () => {
    expect(putSchema.safeParse({ ncm: '123' }).success).toBe(false)
  })

  it('9b. wholesale_price negativo continua rejeitado', () => {
    expect(putSchema.safeParse({ wholesale_price: -10 }).success).toBe(false)
  })

  it('9c. wholesale_price zero continua rejeitado (mesma regra de base_price — > 0 quando informado)', () => {
    expect(putSchema.safeParse({ wholesale_price: 0 }).success).toBe(false)
  })

  it('9d. cest fora do formato (00.000.00) continua rejeitado', () => {
    expect(putSchema.safeParse({ cest: '123456' }).success).toBe(false)
  })

  it('9e. origem fora do intervalo 0-8 continua rejeitada', () => {
    expect(putSchema.safeParse({ origem: 9 }).success).toBe(false)
  })

  it('9f. base_price não-positivo continua rejeitado (campo sem preprocess, comportamento intacto)', () => {
    expect(putSchema.safeParse({ base_price: -1 }).success).toBe(false)
  })

  // ── Sanidade: payload totalmente vazio é válido (PATCH de "nada muda") ──
  it('payload {} é válido — nenhum campo obrigatório no PUT parcial', () => {
    const parsed = putSchema.parse({})
    expect(parsed).toEqual({})
  })
})
