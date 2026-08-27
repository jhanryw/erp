import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFiscalOperation, loadCompanyFiscalPolicy } from './resolveFiscalOperation'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function buildFakeAdmin(policies: Record<string, any>[]) {
  return {
    from: (table: string) => {
      if (table !== 'fiscal_operation_policies') throw new Error(`tabela inesperada: ${table}`)
      const filters: Record<string, unknown> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain },
        async maybeSingle() {
          const row = policies.find((p) => Object.entries(filters).every(([k, v]) => p[k] === v))
          return { data: row ?? null, error: null }
        },
      }
      return chain
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('loadCompanyFiscalPolicy — leitura pura de fiscal_operation_policies', () => {
  it('devolve a policy convertida pra camelCase quando existe linha', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([
      { company_id: 1, operation_type: 'pos_retail', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
    ]))
    const policy = await loadCompanyFiscalPolicy(1, 'pos_retail')
    expect(policy).toEqual({
      fiscalEnabled: true, documentMode: 'nfce', autoIssue: true, autoPrint: true, printNonFiscalReceipt: false, manualIssueAllowed: true,
    })
  })

  it('devolve null quando não existe linha pra essa empresa+operação (nunca inventa default)', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([]))
    expect(await loadCompanyFiscalPolicy(1, 'pos_retail')).toBeNull()
  })
})

describe('resolveFiscalOperation — multiempresa: nenhuma policy vaza entre empresas', () => {
  it('empresa 1 com pos_retail=nfce/auto e empresa 2 SEM policy de pos_retail → resultados completamente diferentes pra mesma venda', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([
      { company_id: 1, operation_type: 'pos_retail', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
      // empresa 2 não tem NENHUMA linha — deve cair em configuration_missing, nunca herdar/vazar a policy da empresa 1
    ]))

    const saleFields = { saleType: 'retail', salesChannel: 'pos', saleOrigin: 'store', deliveryMode: null, operatorChoice: 'auto' as const }

    const empresa1 = await resolveFiscalOperation({ companyId: 1, ...saleFields })
    const empresa2 = await resolveFiscalOperation({ companyId: 2, ...saleFields })

    expect(empresa1.status).toBe('emission_pending')
    expect(empresa1.attempt).toBe('nfce')

    expect(empresa2.status).toBe('configuration_missing')
    expect(empresa2.attempt).toBeNull()
  })

  it('operationType não resolvido (dado corrompido) → configuration_missing sem sequer consultar a policy de outra operação por engano', async () => {
    const admin = buildFakeAdmin([
      { company_id: 1, operation_type: 'pos_retail', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
    ])
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)

    const result = await resolveFiscalOperation({
      companyId: 1, saleType: 'retail', salesChannel: 'canal_desconhecido', saleOrigin: 'other', deliveryMode: null, operatorChoice: 'auto',
    })
    expect(result.status).toBe('configuration_missing')
    expect(result.operationType).toBeNull()
  })
})
