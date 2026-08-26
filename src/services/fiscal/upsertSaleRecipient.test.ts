import { describe, it, expect, vi, afterEach } from 'vitest'
import { upsertSaleRecipient, getSaleRecipient, type FiscalRecipientInput } from './upsertSaleRecipient'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const EMPTY_INPUT: FiscalRecipientInput = {
  nome: null, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null,
  telefone: null, cep: null, logradouro: null, numero: null, complemento: null,
  bairro: null, municipio: null, municipioIbge: null, uf: null, ibgeSource: null,
}

function mockClient({ saleFound = true, upsertError = null as { message: string } | null } = {}) {
  const upsertSpy = vi.fn(async () => ({ error: upsertError }))
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'sales') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: saleFound ? { id: 1 } : null, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'sale_recipients') {
        return { upsert: upsertSpy }
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  return { upsertSpy }
}

describe('upsertSaleRecipient', () => {
  afterEach(() => vi.restoreAllMocks())

  it('venda de outra empresa (ou inexistente) → 404, nunca escreve', async () => {
    const { upsertSpy } = mockClient({ saleFound: false })
    const result = await upsertSaleRecipient(1, 99, { ...EMPTY_INPUT, nome: 'Cliente' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('input totalmente vazio → não escreve nenhuma linha, devolve sucesso com data=null', async () => {
    const { upsertSpy } = mockClient()
    const result = await upsertSaleRecipient(1, 1, EMPTY_INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeNull()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('input com pelo menos um campo (ex.: CPF de NFC-e) → upsert com sale_id/company_id corretos', async () => {
    const { upsertSpy } = mockClient()
    const result = await upsertSaleRecipient(1, 1, { ...EMPTY_INPUT, cpf: '11144477735' })
    expect(result.ok).toBe(true)
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sale_id: 1, company_id: 1, cpf: '11144477735' }),
      { onConflict: 'sale_id' },
    )
  })

  it('UF é normalizada para maiúsculo', async () => {
    const { upsertSpy } = mockClient()
    await upsertSaleRecipient(1, 1, { ...EMPTY_INPUT, nome: 'Loja X', cnpj: '11222333000181', uf: 'sp' })
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ uf: 'SP' }), { onConflict: 'sale_id' })
  })

  it('erro no upsert é reportado, nunca lançado', async () => {
    mockClient({ upsertError: { message: 'boom' } })
    const result = await upsertSaleRecipient(1, 1, { ...EMPTY_INPUT, cpf: '11144477735' })
    expect(result.ok).toBe(false)
  })
})

describe('getSaleRecipient', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sem snapshot ainda → sucesso com null', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: (table: string) => {
        if (table === 'sales') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 1 }, error: null }) }) }) }) }
        if (table === 'sale_recipients') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }
        throw new Error('unexpected table')
      },
    })
    const result = await getSaleRecipient(1, 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeNull()
  })

  it('venda de outra empresa → 404', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    })
    const result = await getSaleRecipient(1, 99)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})
