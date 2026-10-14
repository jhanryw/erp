import { describe, it, expect } from 'vitest'
import { cleanLine, contrastRatio, DEFAULT_SITE_CHROME, DEFAULT_WHATSAPP_FLOAT_MESSAGE, formatCnpj, isValidCnpj, mergeSiteChrome, resolveSiteChrome, safeLinkUrl, siteChromeSchema } from './siteChrome'

describe('safeLinkUrl — só http(s) ou caminho do próprio site', () => {
  it('aceita https, http e caminhos relativos', () => {
    expect(safeLinkUrl('https://instagram.com/santtorini')).toBe('https://instagram.com/santtorini')
    expect(safeLinkUrl('http://exemplo.com/a?b=1')).toBe('http://exemplo.com/a?b=1')
    expect(safeLinkUrl('/politica-de-privacidade')).toBe('/politica-de-privacidade')
    expect(safeLinkUrl('/')).toBe('/')
  })

  it('recusa esquemas perigosos, protocolo relativo, credenciais, espaços e tamanho excessivo', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://x.com',
      '//evil.com/x', '/\\evil.com', 'https://user:pass@evil.com', 'https://a b.com', 'texto solto', '', '   ', 'https://' + 'a'.repeat(600) + '.com']) {
      expect(safeLinkUrl(bad), bad).toBeNull()
    }
    expect(safeLinkUrl(null)).toBeNull()
  })
})

describe('CNPJ e cores', () => {
  it('valida CNPJ pelo dígito verificador e formata', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true)
    expect(isValidCnpj('11222333000181')).toBe(true)
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false)
    expect(isValidCnpj('00000000000000')).toBe(false)
    expect(isValidCnpj('123')).toBe(false)
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81')
  })

  it('razão de contraste WCAG', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1)
    expect(contrastRatio('#A71818', '#FFFFFF')).toBeGreaterThan(7)
    expect(contrastRatio('#25D366', '#FFFFFF')).toBeLessThan(2.1)
  })

  it('cleanLine remove controle e espaços repetidos', () => {
    expect(cleanLine('  a\u0000\u0007   b \n c ')).toBe('a b c')
  })
})

describe('siteChromeSchema — validação na gravação', () => {
  it('aceita configuração completa válida', () => {
    const r = siteChromeSchema.safeParse({
      footer: { sections: { brand: true, store: false }, navigationLinks: [{ label: 'Quem somos', url: '/quem-somos' }], hours: 'Seg a sex' },
      store: { useFiscalData: false, cnpj: '11.222.333/0001-81', state: 'rn', mapsUrl: 'https://maps.google.com/?q=x' },
      social: { instagramUrl: 'https://instagram.com/santtorini' },
      whatsappFloat: { enabledDesktop: true, enabledMobile: false, message: 'Olá!' },
    })
    expect(r.success).toBe(true)
    expect(r.success && r.data.store?.state).toBe('RN')
  })

  it.each([
    ['link javascript: no rodapé', { footer: { legalLinks: [{ label: 'Termos', url: 'javascript:alert(1)' }] } }],
    ['Instagram com data:', { social: { instagramUrl: 'data:text/html,x' } }],
    ['Google Maps inválido', { store: { mapsUrl: 'ftp://x' } }],
    ['CNPJ com dígito errado', { store: { cnpj: '11.222.333/0001-80' } }],
    ['UF com 3 letras', { store: { state: 'RNX' } }],
    ['mais de 8 links', { footer: { navigationLinks: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, url: '/x' })) } }],
    ['texto do link muito longo', { footer: { supportLinks: [{ label: 'x'.repeat(41), url: '/x' }] } }],
    ['chave desconhecida (tentativa de injetar número de WhatsApp)', { whatsappFloat: { phone: '+5511999999999' } }],
    ['horário muito longo', { footer: { hours: 'x'.repeat(121) } }],
  ])('recusa: %s', (_name, payload) => {
    expect(siteChromeSchema.safeParse(payload).success).toBe(false)
  })

  it('não existe campo de número do botão flutuante (usa o WhatsApp do carrinho)', () => {
    expect(Object.keys(DEFAULT_SITE_CHROME.whatsappFloat)).toEqual(['enabledDesktop', 'enabledMobile', 'message'])
  })
})

describe('resolveSiteChrome — leitura tolerante (JSONB antigo/corrompido nunca derruba o site)', () => {
  it('vazio/ausente/lixo → padrões', () => {
    for (const raw of [null, undefined, {}, [], 'x', 42]) expect(resolveSiteChrome(raw)).toEqual(DEFAULT_SITE_CHROME)
    expect(resolveSiteChrome({}).whatsappFloat.message).toBe(DEFAULT_WHATSAPP_FLOAT_MESSAGE)
  })

  it('descarta na LEITURA links inseguros, CNPJ inválido e tipos errados', () => {
    const r = resolveSiteChrome({
      footer: { navigationLinks: [{ label: 'Ok', url: '/ok' }, { label: 'Mal', url: 'javascript:alert(1)' }, { label: '', url: '/x' }, 7], sections: { brand: 'sim' } },
      store: { cnpj: '123', state: 'ZZZ', mapsUrl: 'data:x' },
      social: { instagramUrl: 'javascript:1' },
      whatsappFloat: { enabledDesktop: 'não', message: '   ' },
    })
    expect(r.footer.navigationLinks).toEqual([{ label: 'Ok', url: '/ok' }])
    expect(r.footer.sections.brand).toBe(true) // tipo errado → padrão
    expect(r.store).toMatchObject({ cnpj: '', state: '', mapsUrl: '' })
    expect(r.social.instagramUrl).toBe('')
    expect(r.whatsappFloat).toMatchObject({ enabledDesktop: true, message: DEFAULT_WHATSAPP_FLOAT_MESSAGE })
  })

  it('mergeSiteChrome: parcial por grupo; campo ausente mantém; arrays substituem', () => {
    const current = resolveSiteChrome({ footer: { hours: 'Antes', navigationLinks: [{ label: 'A', url: '/a' }] }, social: { instagramUrl: 'https://instagram.com/x' } })
    const merged = mergeSiteChrome(current, { footer: { navigationLinks: [{ label: 'B', url: '/b' }] }, whatsappFloat: { enabledMobile: false } })
    expect(merged.footer.hours).toBe('Antes')
    expect(merged.footer.navigationLinks).toEqual([{ label: 'B', url: '/b' }])
    expect(merged.social.instagramUrl).toBe('https://instagram.com/x')
    expect(merged.whatsappFloat).toMatchObject({ enabledMobile: false, enabledDesktop: true })
  })
})
