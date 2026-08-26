import { describe, it, expect, vi, afterEach } from 'vitest'
import { getWholesaleCustomerSession } from './session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import * as tenantModule from './tenant'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

function mockAuthUser(user: { id: string } | null) {
  ;(createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    auth: { getUser: async () => ({ data: { user } }) },
  })
}

function mockCustomerLookup(row: any) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }) }),
  })
}

describe('getWholesaleCustomerSession', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sem tenant configurado → null', async () => {
    vi.spyOn(tenantModule, 'resolveWholesaleSiteTenant').mockResolvedValue(null)
    const result = await getWholesaleCustomerSession()
    expect(result).toBeNull()
  })

  it('sem sessão Supabase Auth → null', async () => {
    vi.spyOn(tenantModule, 'resolveWholesaleSiteTenant').mockResolvedValue({ companyId: 1, systemUserId: 'sys-1' })
    mockAuthUser(null)
    const result = await getWholesaleCustomerSession()
    expect(result).toBeNull()
  })

  it('sessão válida mas SEM customers vinculado (ex.: funcionário logado) → null, nunca trata staff como cliente', async () => {
    vi.spyOn(tenantModule, 'resolveWholesaleSiteTenant').mockResolvedValue({ companyId: 1, systemUserId: 'sys-1' })
    mockAuthUser({ id: 'staff-uuid' })
    mockCustomerLookup(null)
    const result = await getWholesaleCustomerSession()
    expect(result).toBeNull()
  })

  it('26. sessão válida com customers da empresa certa → devolve os dados do cliente', async () => {
    vi.spyOn(tenantModule, 'resolveWholesaleSiteTenant').mockResolvedValue({ companyId: 1, systemUserId: 'sys-1' })
    mockAuthUser({ id: 'customer-uuid' })
    mockCustomerLookup({ id: 55, name: 'Loja X', email: 'x@x.com', phone: '119999', cpf: null, cnpj: '11222333000181' })
    const result = await getWholesaleCustomerSession()
    expect(result).toEqual({
      customerId: 55, companyId: 1, name: 'Loja X', email: 'x@x.com', phone: '119999', cpf: null, cnpj: '11222333000181',
    })
  })
})
