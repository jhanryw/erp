import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCompanyIntegrations, findIntegrationByExternalAccount } from '../integrations/company-integrations.service'
import { getIntegrationSecret } from '../integrations/secrets.service'
import { createNuvemshopFakeDb } from './nuvemshop.testutil'
import { resolveNuvemshopContextForCompany, resolveNuvemshopContextForStore } from './context.service'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('../integrations/company-integrations.service', () => ({ listCompanyIntegrations: vi.fn(), findIntegrationByExternalAccount: vi.fn() }))
vi.mock('../integrations/secrets.service', () => ({ getIntegrationSecret: vi.fn() }))

const integration = (over: Record<string, unknown> = {}) => ({ id: 7, company_id: 2, provider: 'nuvemshop', status: 'active', external_account_id: '222', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NUVEMSHOP_STORE_ID', '111')
  vi.stubEnv('NUVEMSHOP_ACCESS_TOKEN', 'env-token')
  vi.stubEnv('NUVEMSHOP_SYSTEM_USER_ID', 'sys')
  ;(createAdminClient as any).mockReturnValue(createNuvemshopFakeDb({ users: [{ id: 'sys', company_id: 1 }] }))
  ;(listCompanyIntegrations as any).mockResolvedValue({ ok: true, data: [] })
  ;(findIntegrationByExternalAccount as any).mockResolvedValue({ ok: true, data: null })
  ;(getIntegrationSecret as any).mockResolvedValue({ ok: true, data: 'secret-token' })
})
afterEach(() => vi.unstubAllEnvs())

describe('resolveNuvemshopContextForCompany', () => {
  it('legado via env vale SOMENTE para a empresa do system user', async () => {
    const own = await resolveNuvemshopContextForCompany(1)
    expect(own.ok && own.data).toMatchObject({ companyId: 1, storeId: '111', source: 'legacy_env' })
    const other = await resolveNuvemshopContextForCompany(2)
    expect(other).toMatchObject({ ok: false, status: 404 })
  })

  it('integração ativa da empresa tem prioridade e usa o segredo dela', async () => {
    ;(listCompanyIntegrations as any).mockResolvedValue({ ok: true, data: [integration()] })
    const r = await resolveNuvemshopContextForCompany(2)
    expect(r.ok && r.data).toMatchObject({ companyId: 2, storeId: '222', integrationId: 7, credentials: { storeId: '222', accessToken: 'secret-token' } })
  })

  it('duas lojas ativas na mesma empresa → 409 (mappings sem coluna de loja)', async () => {
    ;(listCompanyIntegrations as any).mockResolvedValue({ ok: true, data: [integration(), integration({ id: 8, external_account_id: '333' })] })
    expect(await resolveNuvemshopContextForCompany(2)).toMatchObject({ ok: false, status: 409 })
  })

  it('integração sem access_token → 422', async () => {
    ;(listCompanyIntegrations as any).mockResolvedValue({ ok: true, data: [integration()] })
    ;(getIntegrationSecret as any).mockResolvedValue({ ok: true, data: null })
    expect(await resolveNuvemshopContextForCompany(2)).toMatchObject({ ok: false, status: 422 })
  })
})

describe('resolveNuvemshopContextForStore', () => {
  it('store_id do env → empresa do system user', async () => {
    const r = await resolveNuvemshopContextForStore('111')
    expect(r.ok && r.data?.companyId).toBe(1)
  })

  it('store_id de integração cadastrada → empresa dona', async () => {
    ;(findIntegrationByExternalAccount as any).mockResolvedValue({ ok: true, data: integration() })
    ;(listCompanyIntegrations as any).mockImplementation(async (c: number) => ({ ok: true, data: c === 2 ? [integration()] : [] }))
    const r = await resolveNuvemshopContextForStore('222')
    expect(r.ok && r.data).toMatchObject({ companyId: 2, storeId: '222' })
  })

  it('store_id desconhecido ou inválido → null', async () => {
    expect(await resolveNuvemshopContextForStore('999')).toEqual({ ok: true, data: null })
    expect(await resolveNuvemshopContextForStore('abc')).toEqual({ ok: true, data: null })
  })
})
