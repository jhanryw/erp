// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { AnnouncementBar } from './AnnouncementBar'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'

const msg = (id: number, message: string, over: Partial<{ linkUrl: string | null; backgroundColor: string; textColor: string }> = {}) =>
  ({ id, message, linkUrl: null, backgroundColor: '#A71818', textColor: '#FFFFFF', ...over })

const mount = (announcements: ReturnType<typeof msg>[], interval = 5) =>
  render(<WholesaleBasePathProvider basePath=""><AnnouncementBar announcements={announcements} intervalSeconds={interval} /></WholesaleBasePathProvider>)

function mockReducedMotion(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as any
}

beforeEach(() => { vi.useFakeTimers(); mockReducedMotion(false) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('AnnouncementBar', () => {
  it('sem mensagens não renderiza nada', () => {
    const { container } = mount([])
    expect(container.firstChild).toBeNull()
  })

  it('uma mensagem: estática, sem controles de troca', () => {
    mount([msg(1, 'Enviamos para todo o Brasil')])
    expect(screen.getByText('Enviamos para todo o Brasil')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('Enviamos para todo o Brasil')).toBeTruthy()
  })

  it('várias: alterna sozinha no intervalo configurado e dá a volta', () => {
    mount([msg(1, 'Primeira'), msg(2, 'Segunda')], 4)
    expect(screen.getByText('Primeira')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3_900) })
    expect(screen.getByText('Primeira')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByText('Segunda')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(screen.getByText('Primeira')).toBeTruthy()
  })

  it('pausa com mouse, foco e botão Pausar; retoma ao sair', () => {
    mount([msg(1, 'Primeira'), msg(2, 'Segunda')], 3)
    const region = screen.getByRole('region', { name: 'Avisos da loja' })

    fireEvent.mouseEnter(region)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByText('Primeira')).toBeTruthy()
    fireEvent.mouseLeave(region)
    act(() => { vi.advanceTimersByTime(3_100) })
    expect(screen.getByText('Segunda')).toBeTruthy()

    fireEvent.focus(screen.getByRole('button', { name: 'Próximo aviso' }))
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByText('Segunda')).toBeTruthy()
    fireEvent.blur(screen.getByRole('button', { name: 'Próximo aviso' }))

    fireEvent.click(screen.getByRole('button', { name: /Pausar a troca automática/ }))
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByText('Segunda')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retomar a troca automática/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('prefers-reduced-motion: não troca sozinha e esconde o Pausar; navegação manual continua', () => {
    mockReducedMotion(true)
    mount([msg(1, 'Primeira'), msg(2, 'Segunda')], 3)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByText('Primeira')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pausar/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Próximo aviso' }))
    expect(screen.getByText('Segunda')).toBeTruthy()
  })

  it('link opcional: interno vira rota do site; externo abre em nova aba com noopener; sem link é texto', () => {
    mount([msg(1, 'Interno', { linkUrl: '/categorias' }), msg(2, 'Externo', { linkUrl: 'https://instagram.com/santtorini' }), msg(3, 'Sem link')])
    expect((screen.getByText('Interno').closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/categorias')
    fireEvent.click(screen.getByRole('button', { name: 'Próximo aviso' }))
    const ext = screen.getByText('Externo').closest('a') as HTMLAnchorElement
    expect(ext.target).toBe('_blank')
    expect(ext.rel).toContain('noopener')
    fireEvent.click(screen.getByRole('button', { name: 'Próximo aviso' }))
    expect(screen.getByText('Sem link').closest('a')).toBeNull()
  })

  it('cores por mensagem e texto sempre como TEXTO (sem HTML)', () => {
    mount([msg(1, '<img src=x onerror=alert(1)><b>Oi</b>', { backgroundColor: '#111827', textColor: '#FFFFFF' })])
    const region = screen.getByRole('region', { name: 'Avisos da loja' })
    expect(region.style.backgroundColor).toBe('rgb(17, 24, 39)')
    expect(region.querySelector('img, b')).toBeNull()
    expect(region.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('altura fixa no contêiner (sem CLS): h-10 no celular e h-9 no desktop', () => {
    const { container } = mount([msg(1, 'Oi'), msg(2, 'Tchau')])
    expect(container.innerHTML).toContain('h-10')
    expect(container.innerHTML).toContain('sm:h-9')
  })
})
