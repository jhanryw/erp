import { describe, it, expect } from 'vitest'
import { resolveChatwootLauncherUrl } from './resolveChatwootLauncherUrl'

describe('resolveChatwootLauncherUrl', () => {
  it('integração ativa com base_url + external_account_id → monta a URL de inbox-view', () => {
    expect(
      resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 'https://chat.example.com' }, external_account_id: '1' }),
    ).toBe('https://chat.example.com/app/accounts/1/inbox-view')
  })

  it('sem integração → null', () => {
    expect(resolveChatwootLauncherUrl(null)).toBeNull()
  })

  it.each(['pending', 'inactive', 'error'])('status=%s (não-active) → null', (status) => {
    expect(resolveChatwootLauncherUrl({ status, settings: { base_url: 'https://chat.example.com' }, external_account_id: '1' })).toBeNull()
  })

  it('sem settings.base_url configurado → null', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: {}, external_account_id: '1' })).toBeNull()
  })

  it('base_url vazio/só espaço → null', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: '   ' }, external_account_id: '1' })).toBeNull()
  })

  it('base_url de tipo errado → null (nunca confia sem checar tipo)', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 123 }, external_account_id: '1' })).toBeNull()
  })

  it('sem external_account_id configurado → null (nunca hardcoda um account_id)', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 'https://chat.example.com' }, external_account_id: null })).toBeNull()
  })

  it('external_account_id vazio/só espaço → null', () => {
    expect(resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 'https://chat.example.com' }, external_account_id: '   ' })).toBeNull()
  })

  it('remove espaços nas bordas e barra final duplicada de base_url', () => {
    expect(
      resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: '  https://chat.example.com/  ' }, external_account_id: ' 1 ' }),
    ).toBe('https://chat.example.com/app/accounts/1/inbox-view')
  })

  it('external_account_id com caracteres especiais é escapado na URL', () => {
    expect(
      resolveChatwootLauncherUrl({ status: 'active', settings: { base_url: 'https://chat.example.com' }, external_account_id: 'a/b' }),
    ).toBe('https://chat.example.com/app/accounts/a%2Fb/inbox-view')
  })
})
