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
      { company_id: 1, operation_type: 'retail_pickup', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
    ]))
    const policy = await loadCompanyFiscalPolicy(1, 'retail_pickup')
    expect(policy).toEqual({
      fiscalEnabled: true, documentMode: 'nfce', autoIssue: true, autoPrint: true, printNonFiscalReceipt: false, manualIssueAllowed: true,
    })
  })

  it('devolve null quando não existe linha pra essa empresa+operação (nunca inventa default)', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([]))
    expect(await loadCompanyFiscalPolicy(1, 'retail_pickup')).toBeNull()
  })
})

describe('resolveFiscalOperation — multiempresa: nenhuma policy vaza entre empresas', () => {
  it('empresa 1 com retail_pickup=nfce/auto e empresa 2 SEM policy de retail_pickup → resultados completamente diferentes pra mesma venda', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([
      { company_id: 1, operation_type: 'retail_pickup', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
      // empresa 2 não tem NENHUMA linha — deve cair em configuration_missing, nunca herdar/vazar a policy da empresa 1
    ]))

    // salesChannel NÃO é mais parâmetro desta função — consolidação 7→4 tipos removeu-o de propósito (resolveOperationType.ts).
    const saleFields = { saleType: 'retail', saleOrigin: 'store', deliveryMode: null, operatorChoice: 'auto' as const }

    const empresa1 = await resolveFiscalOperation({ companyId: 1, ...saleFields })
    const empresa2 = await resolveFiscalOperation({ companyId: 2, ...saleFields })

    expect(empresa1.status).toBe('emission_pending')
    expect(empresa1.attempt).toBe('nfce')

    expect(empresa2.status).toBe('configuration_missing')
    expect(empresa2.attempt).toBeNull()
  })

  it('operationType não resolvido (delivery_mode corrompido) → configuration_missing sem sequer consultar a policy de outra operação por engano', async () => {
    const admin = buildFakeAdmin([
      { company_id: 1, operation_type: 'retail_pickup', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true },
    ])
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)

    const result = await resolveFiscalOperation({
      companyId: 1, saleType: 'retail', saleOrigin: 'other', deliveryMode: 'valor_invalido', operatorChoice: 'auto',
    })
    expect(result.status).toBe('configuration_missing')
    expect(result.operationType).toBeNull()
  })

  it('venda do site de atacado (saleOrigin=website + saleType=wholesale) → resolve pra website, não wholesale (decisão confirmada na consolidação 7→4)', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(buildFakeAdmin([
      { company_id: 1, operation_type: 'website', fiscal_enabled: true, document_mode: 'nfe', auto_issue: true, auto_print: false, print_non_fiscal_receipt: false, manual_issue_allowed: true },
      { company_id: 1, operation_type: 'wholesale', fiscal_enabled: true, document_mode: 'nfe', auto_issue: false, auto_print: false, print_non_fiscal_receipt: true, manual_issue_allowed: true },
    ]))

    const result = await resolveFiscalOperation({
      companyId: 1, saleType: 'wholesale', saleOrigin: 'website', deliveryMode: null, operatorChoice: 'auto',
    })
    expect(result.operationType).toBe('website')
    expect(result.attempt).toBe('nfe')
    expect(result.status).toBe('emission_pending') // website tem auto_issue=true — se tivesse caído em wholesale, seria manual_issue_required
  })
})
