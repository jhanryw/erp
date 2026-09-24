import { describe, it, expect } from 'vitest'
import { getPublicAppOrigin, publicAppUrl } from './publicOrigin'

describe('getPublicAppOrigin', () => {
  it('APP_URL tem prioridade e é reduzida à origem', () => {
    expect(getPublicAppOrigin({ APP_URL: 'https://santtorini.qarvon.com/', MERCADOLIVRE_REDIRECT_URI: 'https://outro.example/cb' })).toBe('https://santtorini.qarvon.com')
    expect(getPublicAppOrigin({ APP_URL: 'https://santtorini.qarvon.com/algum/path?x=1' })).toBe('https://santtorini.qarvon.com')
  })

  it('fallback: origem da MERCADOLIVRE_REDIRECT_URI; inválidos ignorados', () => {
    expect(getPublicAppOrigin({ APP_URL: 'lixo', MERCADOLIVRE_REDIRECT_URI: 'https://santtorini.qarvon.com/api/integrations/mercadolivre/callback' })).toBe('https://santtorini.qarvon.com')
    expect(getPublicAppOrigin({ APP_URL: 'javascript:alert(1)' })).toBeNull()
    expect(getPublicAppOrigin({})).toBeNull()
  })

  it('publicAppUrl: absoluta com origem; relativa sem; recusa path externo', () => {
    expect(publicAppUrl('/configuracoes/mercadolivre?ml=connected', { APP_URL: 'https://santtorini.qarvon.com' })).toBe('https://santtorini.qarvon.com/configuracoes/mercadolivre?ml=connected')
    expect(publicAppUrl('/x', {})).toBe('/x')
    expect(() => publicAppUrl('//evil.example/x', {})).toThrow()
    expect(() => publicAppUrl('https://evil.example/x', {})).toThrow()
  })
})
