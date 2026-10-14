import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings, getWholesaleCompanyLogoUrl } from '@/services/wholesale/settings'
import { getActiveAnnouncements } from '@/services/wholesale/announcements'
import { getFiscalProfile } from '@/services/wholesale/fiscalProfile'
import { DEFAULT_SITE_CHROME, resolveSiteChrome } from '@/services/wholesale/siteChrome'
import { EMPTY_SITE_TEXTS } from '@/services/wholesale/siteTexts'
import AtacadoLayout from './layout'

vi.mock('@/lib/wholesale/tenant', () => ({ resolveWholesaleSiteTenant: vi.fn() }))
vi.mock('@/lib/wholesale/requestContext', () => ({ getWholesaleBasePath: () => '' }))
vi.mock('@/services/wholesale/settings', () => ({ getWholesaleSiteSettings: vi.fn(), getWholesaleCompanyLogoUrl: vi.fn() }))
vi.mock('@/services/wholesale/announcements', () => ({ getActiveAnnouncements: vi.fn() }))
vi.mock('@/services/wholesale/fiscalProfile', () => ({ getFiscalProfile: vi.fn() }))

const settings = (over: Record<string, unknown> = {}) => ({
  catalogActive: true, displayName: 'Santtorini', whatsappPhone: '(84) 98888-7777', minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null,
  texts: { ...EMPTY_SITE_TEXTS }, chrome: DEFAULT_SITE_CHROME, announcementIntervalSeconds: 5, ...over,
})

const render = async () => renderToStaticMarkup(await AtacadoLayout({ children: <p>conteúdo</p> }))

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesaleSiteTenant as any).mockResolvedValue({ companyId: 1, systemUserId: 'u' })
  ;(getWholesaleCompanyLogoUrl as any).mockResolvedValue(null)
  ;(getActiveAnnouncements as any).mockResolvedValue([])
  ;(getFiscalProfile as any).mockResolvedValue({ cnpj: '11222333000181', razaoSocial: 'Santtorini Comércio LTDA', nomeFantasia: 'Santtorini', logradouro: 'Rua das Flores', numero: '100', complemento: '', bairro: 'Centro', municipio: 'Natal', uf: 'RN' })
  ;(getWholesaleSiteSettings as any).mockResolvedValue(settings())
})

describe('layout do atacado — barra, rodapé e botão flutuante', () => {
  it('sem anúncios ativos não existe barra', async () => {
    expect(await render()).not.toContain('Avisos da loja')
  })

  it('com anúncios ativos a barra vem antes do cabeçalho, já com a 1ª mensagem no HTML (sem CLS)', async () => {
    ;(getActiveAnnouncements as any).mockResolvedValue([
      { id: 1, message: 'Enviamos para todo o Brasil', linkUrl: null, backgroundColor: '#A71818', textColor: '#FFFFFF', isActive: true, sortOrder: 0 },
    ])
    const out = await render()
    expect(out).toContain('Enviamos para todo o Brasil')
    expect(out.indexOf('Avisos da loja')).toBeLessThan(out.indexOf('<header'))
  })

  it('botão flutuante usa o MESMO número do carrinho (whatsapp_phone) normalizado e a mensagem configurada', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({
      chrome: resolveSiteChrome({ whatsappFloat: { message: 'Quero falar com o atendimento' } }),
    }))
    const out = await render()
    expect(out).toContain('data-floating-whatsapp')
    expect(out).toContain('https://wa.me/5584988887777?text=Quero%20falar%20com%20o%20atendimento')
  })

  it('WhatsApp comercial não configurado → sem botão flutuante e sem link de WhatsApp no rodapé', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ whatsappPhone: null }))
    const out = await render()
    expect(out).not.toContain('data-floating-whatsapp')
    expect(out).not.toContain('wa.me')
  })

  it('número inválido também não gera botão', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ whatsappPhone: '123' }))
    expect(await render()).not.toContain('data-floating-whatsapp')
  })

  it('dados fiscais só aparecem no rodapé com a opção ligada; desligada, bloco da loja não existe', async () => {
    expect(await render()).not.toContain('11.222.333/0001-81')
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ chrome: resolveSiteChrome({ store: { useFiscalData: true } }) }))
    const out = await render()
    expect(out).toContain('CNPJ: 11.222.333/0001-81')
    expect(out).toContain('Rua das Flores, 100')
    expect(out).toContain('Natal / RN')
  })

  it('valor digitado no ERP tem prioridade sobre o cadastro fiscal', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ chrome: resolveSiteChrome({ store: { useFiscalData: true, city: 'Mossoró', state: 'RN' } }) }))
    const out = await render()
    expect(out).toContain('Mossoró / RN')
    expect(out).not.toContain('Natal / RN')
  })

  it('configuração antiga (sem chrome) continua funcionando com padrões seguros', async () => {
    const legacy = settings(); delete (legacy as any).chrome; delete (legacy as any).announcementIntervalSeconds
    ;(getWholesaleSiteSettings as any).mockResolvedValue(legacy)
    const out = await render()
    expect(out).toContain('Todos os direitos reservados')
    expect(out).toContain('data-floating-whatsapp')
  })

  it('catálogo desativado: sem barra, sem botão flutuante, rodapé compacto e nada do conteúdo', async () => {
    ;(getActiveAnnouncements as any).mockResolvedValue([{ id: 1, message: 'Promo', linkUrl: null, backgroundColor: '#A71818', textColor: '#FFFFFF', isActive: true, sortOrder: 0 }])
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ catalogActive: false }))
    const out = await render()
    expect(out).not.toContain('Avisos da loja')
    expect(out).not.toContain('data-floating-whatsapp')
    expect(out).not.toContain('conteúdo')
    expect(out).toContain('Todos os direitos reservados')
  })
})
