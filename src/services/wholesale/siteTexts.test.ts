import { describe, it, expect } from 'vitest'
import { cleanSiteText, resolveSiteTexts, wholesaleSiteTextsSchema, SITE_TEXT_LIMITS, EMPTY_SITE_TEXTS } from './siteTexts'

describe('resolveSiteTexts — padrões = textos que o site já exibia', () => {
  it('sem personalização: categorias, "Adicione também", vazio e rodapé padrão; resto desligado', () => {
    const t = resolveSiteTexts(EMPTY_SITE_TEXTS, 'Santtorini')
    expect(t.categoriesTitle).toBe('Nossas categorias')
    expect(t.addAlsoTitle).toBe('Adicione também')
    expect(t.emptyMessage()).toBe('Nenhum produto encontrado.')
    expect(t.emptyMessage('renda')).toBe('Nenhum produto encontrado para "renda".')
    expect(t.footerLines).toEqual(['Santtorini — vendas por atacado'])
    expect([t.heroTitle, t.heroSubtitle, t.productsTitle, t.minimumOrderNote]).toEqual([null, null, null, null])
  })

  it('sem nome da empresa o rodapé padrão usa "Atacado"; configuração ausente também é segura', () => {
    expect(resolveSiteTexts(undefined, null).footerLines).toEqual(['Atacado — vendas por atacado'])
  })

  it('personalização substitui o padrão; rodapé vira uma linha por \\n', () => {
    const t = resolveSiteTexts({ ...EMPTY_SITE_TEXTS, categoriesTitle: 'Coleções', addAlsoTitle: 'Leve mais', emptyMessage: 'Voltamos já', footerText: 'Linha 1\nLinha 2' }, 'X')
    expect(t.categoriesTitle).toBe('Coleções')
    expect(t.addAlsoTitle).toBe('Leve mais')
    expect(t.emptyMessage('qualquer')).toBe('Voltamos já')
    expect(t.footerLines).toEqual(['Linha 1', 'Linha 2'])
  })
})

describe('cleanSiteText', () => {
  it('remove caracteres de controle e espaços extras; vazio vira null', () => {
    expect(cleanSiteText('  Olá\u0000\u0007   mundo \t ', false)).toBe('Olá mundo')
    expect(cleanSiteText('   ', false)).toBeNull()
    expect(cleanSiteText('\u0000\u0001', true)).toBeNull()
  })
  it('multilinha preserva quebras (no máximo uma linha em branco) e normaliza CRLF', () => {
    expect(cleanSiteText('a\r\nb\n\n\n\nc', true)).toBe('a\nb\n\nc')
  })
})

describe('wholesaleSiteTextsSchema', () => {
  it('chave ausente continua undefined (PUT parcial não apaga); vazio/branco vira null (volta ao padrão)', () => {
    const parsed = wholesaleSiteTextsSchema.parse({ heroTitle: '  ', categoriesTitle: ' Coleções ' })
    expect(parsed.heroTitle).toBeNull()
    expect(parsed.categoriesTitle).toBe('Coleções')
    expect(parsed.footerText).toBeUndefined()
    expect(Object.keys(parsed)).not.toContain('footerText') // ausente de verdade: o merge do serviço não o toca
  })

  it('rejeita acima do limite de cada campo', () => {
    for (const [key, max] of Object.entries(SITE_TEXT_LIMITS)) {
      expect(wholesaleSiteTextsSchema.safeParse({ [key]: 'x'.repeat(max) }).success).toBe(true)
      expect(wholesaleSiteTextsSchema.safeParse({ [key]: 'x'.repeat(max + 1) }).success).toBe(false)
    }
  })

  it('strict: chave desconhecida (ex.: tentar enviar o valor do mínimo) é rejeitada', () => {
    expect(wholesaleSiteTextsSchema.strict().safeParse({ minimumOrderAmount: 1 }).success).toBe(false)
  })

  it('não-string é rejeitado', () => {
    expect(wholesaleSiteTextsSchema.safeParse({ heroTitle: 123 }).success).toBe(false)
  })
})
