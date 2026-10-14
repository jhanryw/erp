import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole } from '@/lib/supabase/session'
import { getWholesaleSiteSettings, updateWholesaleSiteSettings } from '@/services/wholesale/settings'
import { PUT } from './route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/services/wholesale/settings', () => ({ getWholesaleSiteSettings: vi.fn(), updateWholesaleSiteSettings: vi.fn() }))

const put = (body: unknown) => PUT(new Request('http://x/api/configuracoes/atacado', { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.resetAllMocks()
  ;(requireRole as any).mockResolvedValue({ user: { company_id: 7, role: 'admin' }, response: null })
  ;(updateWholesaleSiteSettings as any).mockResolvedValue({ ok: true, data: { texts: {} } })
  ;(getWholesaleSiteSettings as any).mockResolvedValue({ pixelId: null })
})

describe('PUT /api/configuracoes/atacado — textos', () => {
  it('só admin: sem permissão a rota responde o bloqueio e não grava', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: new Response('{}', { status: 403 }) })
    expect((await put({ texts: { heroTitle: 'x' } })).status).toBe(403)
    expect(updateWholesaleSiteSettings).not.toHaveBeenCalled()
  })

  it('grava na empresa da SESSÃO, ignorando company_id enviado no corpo', async () => {
    const res = await put({ company_id: 99, companyId: 99, texts: { heroTitle: '  Olá  ', footerText: '' } })
    expect(res.status).toBe(200)
    expect(updateWholesaleSiteSettings).toHaveBeenCalledWith(7, { texts: { heroTitle: 'Olá', footerText: null } })
  })

  it('valida tamanho e tipo; nada é gravado quando inválido', async () => {
    expect((await put({ texts: { heroTitle: 'x'.repeat(81) } })).status).toBe(422)
    expect((await put({ texts: { footerText: 'x'.repeat(501) } })).status).toBe(422)
    expect((await put({ texts: { heroTitle: 5 } })).status).toBe(422)
    expect(updateWholesaleSiteSettings).not.toHaveBeenCalled()
  })

  it('texto não carrega regra comercial: chave desconhecida em texts é rejeitada', async () => {
    expect((await put({ texts: { minimumOrderAmount: 1 } })).status).toBe(422)
    expect(updateWholesaleSiteSettings).not.toHaveBeenCalled()
  })

  it('o valor mínimo continua vindo do campo numérico comercial', async () => {
    await put({ minimumOrderAmount: 450, texts: { minimumOrderNote: 'Mínimo de R$ 1' } })
    expect(updateWholesaleSiteSettings).toHaveBeenCalledWith(7, { minimumOrderAmount: 450, texts: { minimumOrderNote: 'Mínimo de R$ 1' } })
  })

  it('payload sem texts não toca nos textos', async () => {
    await put({ minimumOrderAmount: 400 })
    expect(updateWholesaleSiteSettings).toHaveBeenCalledWith(7, { minimumOrderAmount: 400 })
  })

  describe('chrome (rodapé, loja, redes e botão flutuante)', () => {
    it('grava na empresa da sessão e aceita configuração válida', async () => {
      const chrome = { footer: { hours: 'Seg a sex' }, store: { cnpj: '11.222.333/0001-81', state: 'rn' }, social: { instagramUrl: 'https://instagram.com/x' }, whatsappFloat: { enabledMobile: false } }
      const res = await put({ company_id: 99, chrome, announcementIntervalSeconds: 8 })
      expect(res.status).toBe(200)
      expect(updateWholesaleSiteSettings).toHaveBeenCalledWith(7, expect.objectContaining({
        announcementIntervalSeconds: 8,
        chrome: expect.objectContaining({ store: expect.objectContaining({ cnpj: '11.222.333/0001-81', state: 'RN' }) }),
      }))
    })

    it.each([
      ['link javascript: nos links legais', { footer: { legalLinks: [{ label: 'T', url: 'javascript:alert(1)' }] } }],
      ['Instagram com data:', { social: { instagramUrl: 'data:text/html,x' } }],
      ['CNPJ inválido', { store: { cnpj: '11.222.333/0001-80' } }],
      ['número próprio do botão flutuante (não existe 2º número)', { whatsappFloat: { phone: '+5584999999999' } }],
      ['mensagem do botão acima de 300', { whatsappFloat: { message: 'x'.repeat(301) } }],
    ])('recusa: %s', async (_n, chrome) => {
      expect((await put({ chrome })).status).toBe(422)
      expect(updateWholesaleSiteSettings).not.toHaveBeenCalled()
    })

    it('intervalo da barra fora de 3–30 s é recusado', async () => {
      expect((await put({ announcementIntervalSeconds: 1 })).status).toBe(422)
      expect((await put({ announcementIntervalSeconds: 31 })).status).toBe(422)
    })

    it('o número do botão flutuante é o whatsappPhone (campo único), validado como sempre', async () => {
      expect((await put({ whatsappPhone: '123' })).status).toBe(422)
      expect((await put({ whatsappPhone: '84988887777' })).status).toBe(200)
    })
  })
})
