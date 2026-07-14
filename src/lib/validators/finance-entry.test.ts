import { describe, it, expect } from 'vitest'
import { financeEntrySchema, normalizeFinanceEntryPayment } from '@/lib/validators'
import { brazilDate } from '@/lib/utils/date'

const today = brazilDate()

const base = {
  type: 'income' as const,
  category: 'sale' as const,
  description: 'Venda balcão',
  amount: 150,
  reference_date: today,
}

describe('financeEntrySchema — receita/venda', () => {
  // Cenário 1: venda pendente
  it('aceita receita de venda pendente (payment_method e paid_at ausentes)', () => {
    const parsed = financeEntrySchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(normalizeFinanceEntryPayment(parsed.data)).toEqual({
      payment_method: null,
      paid_at: null,
    })
  })

  // Cenário 2: recebida via Pix
  it('aceita receita de venda recebida por Pix', () => {
    const parsed = financeEntrySchema.safeParse({ ...base, payment_method: 'pix', paid_at: today })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(normalizeFinanceEntryPayment(parsed.data)).toEqual({
      payment_method: 'pix',
      paid_at: today,
    })
  })

  // Cenário 3: recebida por cartão
  it('aceita receita de venda recebida por cartão de crédito', () => {
    const parsed = financeEntrySchema.safeParse({ ...base, payment_method: 'credit_card', paid_at: today })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(normalizeFinanceEntryPayment(parsed.data)).toEqual({
      payment_method: 'credit_card',
      paid_at: today,
    })
  })

  // Cenário 4: recebida em dinheiro — cash_movement_id não é aceito por este schema
  it('aceita receita de venda recebida em dinheiro, e rejeita cash_movement_id no payload', () => {
    const parsed = financeEntrySchema.safeParse({ ...base, payment_method: 'cash', paid_at: today })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(normalizeFinanceEntryPayment(parsed.data)).toEqual({
      payment_method: 'cash',
      paid_at: today,
    })

    const withCashMovement = financeEntrySchema.safeParse({
      ...base,
      payment_method: 'cash',
      paid_at: today,
      cash_movement_id: 123,
    })
    expect(withCashMovement.success).toBe(false)
  })

  // Cenário 5: marcar como recebido sem forma de pagamento (e o inverso)
  it('bloqueia paid_at preenchido sem payment_method', () => {
    const parsed = financeEntrySchema.safeParse({ ...base, paid_at: today })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues.find((i) => i.path.join('.') === 'payment_method')
    expect(issue?.message).toBe('Informe a forma de pagamento para registrar o recebimento.')
  })

  it('bloqueia payment_method preenchido sem paid_at', () => {
    const parsed = financeEntrySchema.safeParse({ ...base, payment_method: 'pix' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues.find((i) => i.path.join('.') === 'paid_at')
    expect(issue?.message).toBe('Informe a data de recebimento para registrar o pagamento.')
  })

  // Cenário 6: mudar de recebido para pendente — normalização explícita em null,
  // nunca undefined (a causa raiz do bug: undefined é omitido pelo JSON.stringify
  // e o UPDATE do supabase-js preserva o valor antigo da coluna).
  it('normaliza payment_method/paid_at para null explícito ao limpar os campos na edição', () => {
    const parsed = financeEntrySchema.safeParse({
      ...base,
      payment_method: undefined,
      paid_at: undefined,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const normalized = normalizeFinanceEntryPayment(parsed.data)
    const payload = { ...parsed.data, ...normalized }

    // As duas chaves precisam sobreviver ao JSON.stringify como `null`,
    // nunca desaparecer (que é o que undefined faria).
    const serialized = JSON.parse(JSON.stringify(payload))
    expect(serialized).toHaveProperty('payment_method', null)
    expect(serialized).toHaveProperty('paid_at', null)
  })

  // Cenário 7: edição de um lançamento antigo (payment_method/paid_at já nulos)
  // sem tocar nesses campos — não pode violar a constraint.
  it('permite editar outros campos de um lançamento antigo sem forma de pagamento', () => {
    const parsed = financeEntrySchema.safeParse({
      ...base,
      description: 'Venda balcão — descrição corrigida',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const normalized = normalizeFinanceEntryPayment(parsed.data)
    expect(normalized.payment_method === null && normalized.paid_at === null).toBe(true)
  })
})

describe('financeEntrySchema — despesa (regressão)', () => {
  const expenseBase = {
    type: 'expense' as const,
    category: 'operational' as const,
    description: 'Conta de luz',
    amount: 200,
    reference_date: today,
  }

  it('continua exigindo payment_method e paid_at juntos para despesa', () => {
    const missingBoth = financeEntrySchema.safeParse(expenseBase)
    expect(missingBoth.success).toBe(false)

    const complete = financeEntrySchema.safeParse({ ...expenseBase, payment_method: 'pix', paid_at: today })
    expect(complete.success).toBe(true)
  })
})
