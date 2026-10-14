// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { AtacadoConfigClient } from './AtacadoConfigClient'
import { DEFAULT_SITE_CHROME } from '@/services/wholesale/siteChrome'
import { EMPTY_SITE_TEXTS } from '@/services/wholesale/siteTexts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/link', () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))
vi.mock('./CompanyLogoManager', () => ({ CompanyLogoManager: () => <div>logo-manager</div> }))
vi.mock('./BannerManager', () => ({ BannerManager: () => <div>banner-manager</div> }))
vi.mock('./CategoryCoverManager', () => ({ CategoryCoverManager: () => <div>cover-manager</div> }))

const settings = (over: Record<string, unknown> = {}) => ({
  catalogActive: true, displayName: 'Santtorini', whatsappPhone: '84988887777', minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null,
  texts: { ...EMPTY_SITE_TEXTS, footerText: 'Moda íntima por atacado' }, chrome: DEFAULT_SITE_CHROME, announcementIntervalSeconds: 5, ...over,
})

let calls: Array<{ url: string; method: string; body: any }>

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('/api/configuracoes/atacado/anuncios')) return { ok: true, status: 200, json: async () => ({ announcements: [], migrationPending: false }) }
    return { ok: true, status: 200, json: async () => ({ settings: settings() }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = (over: Record<string, unknown> = {}) =>
  render(<AtacadoConfigClient companyId={1} initialSettings={settings(over) as any} initialBanners={[]} logoUrl={null} />)
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))

describe('Personalização do site (ERP) — abas', () => {
  it('seis seções organizadas em abas, abrindo em Identidade e textos', () => {
    mount()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Identidade e textos', 'Banners', 'Categorias', 'Barra de anúncios', 'Rodapé e loja', 'WhatsApp e redes',
    ])
    expect(screen.getByRole('tab', { name: 'Identidade e textos' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('logo-manager')).toBeTruthy()
  })

  it('cada aba mostra o seu conteúdo (reaproveita banners, capas e grupos de cores)', () => {
    mount()
    tab('Banners'); expect(screen.getByText('banner-manager')).toBeTruthy()
    tab('Categorias'); expect(screen.getByText('cover-manager')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Gerenciar grupos de cores' })).toBeTruthy()
  })

  it('o texto do rodapé existe em UM lugar só (aba Rodapé), não na Identidade', () => {
    mount()
    expect(screen.queryByLabelText('Descrição institucional do rodapé')).toBeNull()
    tab('Rodapé e loja')
    expect((screen.getByLabelText('Descrição institucional do rodapé') as HTMLTextAreaElement).value).toBe('Moda íntima por atacado')
  })
})

describe('Rodapé e loja', () => {
  it('prévia do rodapé reflete as seções e os dados digitados', () => {
    mount()
    tab('Rodapé e loja')
    const preview = screen.getByLabelText('Rodapé') // <footer aria-label="Rodapé"> renderizado na prévia
    expect(within(preview).getByText('Navegação')).toBeTruthy()
    expect(within(preview).queryByText('Nossa loja')).toBeNull()

    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Natal' } })
    expect(within(preview).getByText('Nossa loja')).toBeTruthy()
    expect(within(preview).getByText('Natal')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Navegação' }))
    expect(within(preview).queryByText('Navegação')).toBeNull()
  })

  it('valida CNPJ, Maps e links na própria tela; link inseguro mostra o aviso', () => {
    mount()
    tab('Rodapé e loja')
    fireEvent.change(screen.getByLabelText('CNPJ'), { target: { value: '11.222.333/0001-80' } })
    expect(screen.getByText('CNPJ inválido.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('CNPJ'), { target: { value: '11.222.333/0001-81' } })
    expect(screen.queryByText('CNPJ inválido.')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /Adicionar link/ })[0])
    fireEvent.change(screen.getByLabelText('Navegação — links adicionais: endereço do link 1'), { target: { value: 'javascript:alert(1)' } })
    expect(screen.getByText(/Outros esquemas \(javascript:, data:\) são recusados/)).toBeTruthy()
  })

  it('salvar envia o chrome sem linhas em branco e com o texto do rodapé; WhatsApp do carrinho preservado', async () => {
    mount()
    tab('Rodapé e loja')
    fireEvent.click(screen.getAllByRole('button', { name: /Adicionar link/ })[0]) // linha em branco
    fireEvent.change(screen.getByLabelText('Horário de atendimento (opcional)'), { target: { value: 'Seg a sex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }))

    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy())
    const body = calls.find((c) => c.method === 'PUT')!.body
    expect(body.chrome.footer.navigationLinks).toEqual([])
    expect(body.chrome.footer.hours).toBe('Seg a sex')
    expect(body.whatsappPhone).toBe('84988887777')
    expect(body.texts.footerText).toBe('Moda íntima por atacado')
  })
})

describe('WhatsApp e redes', () => {
  it('um único número (o do carrinho) — campo de telefone único e botão sem número próprio', () => {
    mount()
    tab('WhatsApp e redes')
    expect(screen.getAllByLabelText(/número/i)).toHaveLength(1)
    expect((screen.getByLabelText('Número do WhatsApp da loja') as HTMLInputElement).value).toBe('84988887777')
    expect(screen.getByText(/o mesmo número/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Testar' }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/5584988887777\?text=/)
  })

  it('sem WhatsApp configurado avisa que o botão não aparece', () => {
    mount({ whatsappPhone: null })
    tab('WhatsApp e redes')
    expect(screen.getByText(/o botão não será exibido/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Testar' })).toBeNull()
  })

  it('exibição desktop/mobile, mensagem e Instagram vão no mesmo salvamento', async () => {
    mount()
    tab('WhatsApp e redes')
    fireEvent.click(screen.getByLabelText('Exibir no celular'))
    fireEvent.change(screen.getByLabelText('Mensagem inicial do atendimento'), { target: { value: 'Preciso de ajuda' } })
    fireEvent.change(screen.getByLabelText('Instagram (link do perfil)'), { target: { value: 'https://instagram.com/santtorini' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PUT')!.body.chrome).toMatchObject({
      whatsappFloat: { enabledDesktop: true, enabledMobile: false, message: 'Preciso de ajuda' },
      social: { instagramUrl: 'https://instagram.com/santtorini' },
    })
  })
})

describe('Barra de anúncios', () => {
  it('mostra o aviso de contraste da prévia e o intervalo vai no salvamento', async () => {
    mount()
    tab('Barra de anúncios')
    await screen.findByText('Nova mensagem')
    fireEvent.change(screen.getByLabelText(/Mensagem \(até 160 caracteres\)/), { target: { value: 'Enviamos para todo o Brasil' } })
    expect(screen.getByText(/Contraste .*:1 \(legível\)/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/Trocar de mensagem a cada/), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy())
    expect(calls.find((c) => c.method === 'PUT')!.body.announcementIntervalSeconds).toBe(9)
  })
})
