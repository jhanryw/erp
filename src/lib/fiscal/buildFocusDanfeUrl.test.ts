import { describe, it, expect } from 'vitest'
import { buildFocusDanfeUrl } from './buildFocusDanfeUrl'

describe('buildFocusDanfeUrl', () => {
  it('combina o host de homologação com um caminho relativo válido', () => {
    expect(buildFocusDanfeUrl('homologacao', '/notas_fiscais_consumidor/NFe123.html'))
      .toBe('https://homologacao.focusnfe.com.br/notas_fiscais_consumidor/NFe123.html')
  })

  it('combina o host de produção com um caminho relativo válido', () => {
    expect(buildFocusDanfeUrl('producao', '/arquivos/danfe.pdf'))
      .toBe('https://api.focusnfe.com.br/arquivos/danfe.pdf')
  })

  it('danfePath nulo/undefined → null', () => {
    expect(buildFocusDanfeUrl('homologacao', null)).toBeNull()
    expect(buildFocusDanfeUrl('homologacao', undefined)).toBeNull()
  })

  it('danfePath vazio → null', () => {
    expect(buildFocusDanfeUrl('homologacao', '')).toBeNull()
  })

  it('rejeita URL absoluta embutida (http/https) — nunca redireciona pra host arbitrário', () => {
    expect(buildFocusDanfeUrl('homologacao', 'https://evil.example/danfe.pdf')).toBeNull()
    expect(buildFocusDanfeUrl('homologacao', 'http://evil.example/danfe.pdf')).toBeNull()
  })

  it('rejeita protocol-relative (//host/...) — mesmo risco de host arbitrário', () => {
    expect(buildFocusDanfeUrl('homologacao', '//evil.example/danfe.pdf')).toBeNull()
  })

  it('rejeita caminho sem barra inicial', () => {
    expect(buildFocusDanfeUrl('homologacao', 'notas_fiscais_consumidor/NFe123.html')).toBeNull()
  })

  it('rejeita "://" embutido em qualquer posição do caminho', () => {
    expect(buildFocusDanfeUrl('homologacao', '/redirect?u=http://evil.example')).toBeNull()
  })
})
