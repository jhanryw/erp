// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

let path = '/produto/12'
vi.mock('next/navigation', () => ({ usePathname: () => path }))
import { FloatingWhatsApp } from './FloatingWhatsApp'

const rect = (l: number, t: number, w: number, h: number) =>
  ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON() {} }) as DOMRect

describe('FloatingWhatsApp no produto', () => {
  beforeEach(() => {
    cleanup()
    path = '/produto/12'
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  function setup(buttonRect: DOMRect) {
    const { container } = render(
      <>
        <main><button id="add">Adicionar</button></main>
        <FloatingWhatsApp url="https://wa.me/5584988887777" enabledDesktop enabledMobile />
      </>,
    )
    const a = container.querySelector('[data-floating-whatsapp]') as HTMLElement
    vi.spyOn(a, 'getBoundingClientRect').mockReturnValue(buttonRect)
    Object.defineProperty(a, 'offsetParent', { value: document.body })
    return { a, add: container.querySelector('#add') as HTMLElement }
  }

  it('recua quando sobrepõe um controle e volta quando sai de cima', async () => {
    const { a, add } = setup(rect(300, 700, 48, 48))
    vi.spyOn(add, 'getBoundingClientRect').mockReturnValue(rect(290, 710, 80, 40))
    await act(async () => { window.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 10)) })
    expect(a.getAttribute('data-covering')).toBe('true')
    expect(a.className).toContain('max-lg:opacity-0')

    vi.spyOn(add, 'getBoundingClientRect').mockReturnValue(rect(20, 200, 80, 40))
    await act(async () => { window.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 10)) })
    expect(a.getAttribute('data-covering')).toBeNull()
  })

  it('permanece visível no produto quando nada é coberto', async () => {
    const { a, add } = setup(rect(300, 700, 48, 48))
    vi.spyOn(add, 'getBoundingClientRect').mockReturnValue(rect(20, 100, 80, 40))
    await act(async () => { window.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 10)) })
    expect(a.className).not.toContain('max-lg:hidden')
    expect(a.getAttribute('data-covering')).toBeNull()
  })

  it('segue oculto no celular em /carrinho', () => {
    path = '/carrinho'
    const { container } = render(<FloatingWhatsApp url="https://wa.me/5584988887777" enabledDesktop enabledMobile />)
    expect(container.querySelector('[data-floating-whatsapp]')!.className).toContain('max-lg:hidden')
  })
})
