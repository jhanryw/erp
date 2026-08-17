import { describe, it, expect } from 'vitest'
import { resolveChatwootLauncherUrl } from './resolveChatwootLauncherUrl'

describe('resolveChatwootLauncherUrl', () => {
  it('integração ativa com base_url → devolve a URL', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 'https://chat.example.com' } })).toBe('https://chat.example.com')
  })

  it('sem integração → null', () => {
    expect(resolveChatwootLauncherUrl(null)).toBeNull()
  })

  it.each(['pending', 'inactive', 'error'])('status=%s (não-active) → null', (status) => {
    expect(resolveChatwootLauncherUrl({ status, settings: { base_url: 'https://chat.example.com' } })).toBeNull()
  })

  it('sem settings.base_url configurado → null', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: {} })).toBeNull()
  })

  it('base_url vazio/só espaço → null', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: '   ' } })).toBeNull()
  })

  it('base_url de tipo errado → null (nunca confia sem checar tipo)', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 123 } })).toBeNull()
  })

  it('remove espaços nas bordas', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: '  https://chat.example.com  ' } })).toBe('https://chat.example.com')
  })
})
