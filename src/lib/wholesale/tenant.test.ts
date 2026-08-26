import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { resolveWholesaleSiteTenant, __resetWholesaleTenantCache } from './tenant'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const ORIGINAL_ENV = process.env.WHOLESALE_SITE_SYSTEM_USER_ID

describe('resolveWholesaleSiteTenant', () => {
  beforeEach(() => __resetWholesaleTenantCache())
  afterEach(() => {
    vi.restoreAllMocks()
    process.env.WHOLESALE_SITE_SYSTEM_USER_ID = ORIGINAL_ENV
  })

  it('sem env var configurada → null, nunca inventa um tenant default', async () => {
    delete process.env.WHOLESALE_SITE_SYSTEM_USER_ID
    const result = await resolveWholesaleSiteTenant()
    expect(result).toBeNull()
  })

  it('env var aponta pra usuário sem empresa → null', async () => {
    process.env.WHOLESALE_SITE_SYSTEM_USER_ID = 'sys-1'
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { company_id: null } }) }) }) }),
    })
    const result = await resolveWholesaleSiteTenant()
    expect(result).toBeNull()
  })

  it('8. resolve company_id/systemUserId a partir do usuário de sistema configurado — nunca do browser', async () => {
    process.env.WHOLESALE_SITE_SYSTEM_USER_ID = 'sys-1'
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { company_id: 42 } }) }) }) }),
    })
    const result = await resolveWholesaleSiteTenant()
    expect(result).toEqual({ companyId: 42, systemUserId: 'sys-1' })
  })
})
