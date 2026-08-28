import { describe, it, expect } from 'vitest'
import { resolveFocusResourceUrl } from './resolveFocusResourceUrl'

describe('resolveFocusResourceUrl', () => {
  it('combina o host de homologação com um caminho relativo válido', () => {
    expect(resolveFocusResourceUrl({ path: '/notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' }))
      .toBe('https://homologacao.focusnfe.com.br/notas_fiscais_consumidor/NFe123.html')
  })

  it('combina o host de produção com um caminho relativo válido', () => {
    expect(resolveFocusResourceUrl({ path: '/arquivos/danfe.pdf', environment: 'producao' }))
      .toBe('https://api.focusnfe.com.br/arquivos/danfe.pdf')
  })

  it('caminho relativo em homologação NUNCA resolve contra o host do ERP (regressão exata da venda 703)', () => {
    const result = resolveFocusResourceUrl({
      path: '/arquivos_development/61523225000117_246513/202608/XMLs/24260861523225000117650010000000031299421242-nfe.xml',
      environment: 'homologacao',
    })
    expect(result).toBe(
      'https://homologacao.focusnfe.com.br/arquivos_development/61523225000117_246513/202608/XMLs/24260861523225000117650010000000031299421242-nfe.xml',
    )
    expect(result).not.toContain('santtorini.qarvon.com')
  })

  it('path nulo/undefined/vazio → null', () => {
    expect(resolveFocusResourceUrl({ path: null, environment: 'homologacao' })).toBeNull()
    expect(resolveFocusResourceUrl({ path: undefined, environment: 'homologacao' })).toBeNull()
    expect(resolveFocusResourceUrl({ path: '', environment: 'homologacao' })).toBeNull()
  })

  it('URL já absoluta (http/https) permanece inalterada', () => {
    expect(resolveFocusResourceUrl({ path: 'https://homologacao.focusnfe.com.br/ja/absoluta.pdf', environment: 'producao' }))
      .toBe('https://homologacao.focusnfe.com.br/ja/absoluta.pdf')
    expect(resolveFocusResourceUrl({ path: 'http://exemplo.com/x.xml', environment: 'homologacao' }))
      .toBe('http://exemplo.com/x.xml')
  })

  it('rejeita protocol-relative (//host/...) — mesmo risco de host arbitrário', () => {
    expect(resolveFocusResourceUrl({ path: '//evil.example/danfe.pdf', environment: 'homologacao' })).toBeNull()
  })

  it('rejeita caminho sem barra inicial', () => {
    expect(resolveFocusResourceUrl({ path: 'notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' })).toBeNull()
  })

  it('rejeita "://" embutido em qualquer posição do caminho relativo', () => {
    expect(resolveFocusResourceUrl({ path: '/redirect?u=http://evil.example', environment: 'homologacao' })).toBeNull()
  })
})
