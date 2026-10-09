import { describe, it, expect, vi } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

vi.mock('@/lib/wholesale/tenant', () => ({ resolveWholesaleSiteTenant: vi.fn() }))
vi.mock('@/lib/wholesale/requestContext', () => ({ getWholesaleBasePath: () => '' }))
vi.mock('@/services/wholesale/settings', () => ({ getWholesaleSiteSettings: vi.fn(), getWholesaleCompanyLogoUrl: vi.fn() }))

describe('favicon do atacado (metadata do Next)', () => {
  it('declara ícones da marca e todos os arquivos existem em /public, estáticos (sem autenticação)', async () => {
    const { metadata } = await import('./layout')
    const icons = metadata.icons as { icon: { url: string; sizes: string }[]; apple: { url: string }[] }
    const urls = [...icons.icon, ...icons.apple].map((i) => i.url)
    expect(urls.length).toBeGreaterThanOrEqual(3)
    for (const url of urls) {
      expect(url).toMatch(/^\/icons\/.+\.png$/) // .png fica fora do matcher do middleware de login
      const file = path.join(process.cwd(), 'public', url)
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).size).toBeLessThan(20_000) // leve; o de 1080 px não é usado como ícone de aba
    }
  })
})
