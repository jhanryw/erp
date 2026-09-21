import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveWholesaleSiteTenant } from './tenant'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { logError } from '@/lib/errors/log'
import { resolveWholesalePublicContext } from './publicContext'

vi.mock('./tenant', () => ({ resolveWholesaleSiteTenant: vi.fn() }))
vi.mock('@/services/wholesale/settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesaleSiteTenant as any).mockResolvedValue({ companyId: 1, systemUserId: 'u' })
})

describe('resolveWholesalePublicContext', () => {
  it('sem tenant configurado → 503', async () => {
    ;(resolveWholesaleSiteTenant as any).mockResolvedValue(null)
    expect(await resolveWholesalePublicContext()).toMatchObject({ ok: false, status: 503 })
  })
  it('catalog_active=false → 503 (controle mestre)', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue({ catalogActive: false })
    expect(await resolveWholesalePublicContext()).toMatchObject({ ok: false, status: 503 })
  })
  it('catálogo ativo → ok com a empresa do tenant', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue({ catalogActive: true })
    expect(await resolveWholesalePublicContext()).toMatchObject({ ok: true, companyId: 1 })
  })
  it('falha ao ler a configuração → FECHA (503) e loga; nunca abre o catálogo por padrão', async () => {
    ;(getWholesaleSiteSettings as any).mockRejectedValue(new Error('db down'))
    expect(await resolveWholesalePublicContext()).toMatchObject({ ok: false, status: 503 })
    expect(logError).toHaveBeenCalled()
  })
})
