import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  trackPageView,
  trackViewContent,
  trackAddToCart,
  trackInitiateCheckout,
  __resetMetaPixelDedupeForTests,
} from './metaPixel'

// Sem jsdom neste projeto (ambiente vitest default é 'node', sem `window`
// global) — `metaPixel.ts` já é escrito pra rodar em SSR (checa
// `typeof window !== 'undefined'`), então o teste só precisa de um stub
// mínimo de `window`, não de um DOM completo.
beforeEach(() => {
  ;(globalThis as any).window = {}
})
afterEach(() => {
  delete (globalThis as any).window
})

describe('Meta Pixel — no-op quando não carregado', () => {
  afterEach(() => {
    delete (window as any).fbq
  })

  it('trackPageView não lança quando window.fbq não existe', () => {
    expect(() => trackPageView('/')).not.toThrow()
  })

  it('trackViewContent/trackAddToCart/trackInitiateCheckout são no-op sem fbq', () => {
    expect(() => trackViewContent({ contentId: '1', contentName: 'P', value: 10 })).not.toThrow()
    expect(() => trackAddToCart({ contentId: '1', contentName: 'P', value: 10, quantity: 1 })).not.toThrow()
    expect(() => trackInitiateCheckout({ contentIds: ['1'], value: 10, numItems: 1 })).not.toThrow()
  })
})

describe('Meta Pixel — com fbq carregado', () => {
  afterEach(() => {
    delete (window as any).fbq
    __resetMetaPixelDedupeForTests()
  })

  it('trackPageView dispara "track PageView" uma vez por pathname', () => {
    const fbq = vi.fn()
    ;(window as any).fbq = fbq

    trackPageView('/produto/1')
    trackPageView('/produto/1') // mesma rota — dedupe, não deve disparar de novo
    expect(fbq).toHaveBeenCalledTimes(1)
    expect(fbq).toHaveBeenCalledWith('track', 'PageView')

    trackPageView('/produto/2') // rota diferente — dispara de novo
    expect(fbq).toHaveBeenCalledTimes(2)
  })

  it('trackViewContent envia content_ids, value e currency BRL', () => {
    const fbq = vi.fn()
    ;(window as any).fbq = fbq

    trackViewContent({ contentId: '42', contentName: 'Calcinha', value: 19.9 })

    expect(fbq).toHaveBeenCalledWith('track', 'ViewContent', {
      content_ids: ['42'],
      content_name: 'Calcinha',
      content_type: 'product',
      value: 19.9,
      currency: 'BRL',
    })
  })

  it('trackAddToCart inclui quantity', () => {
    const fbq = vi.fn()
    ;(window as any).fbq = fbq

    trackAddToCart({ contentId: '42', contentName: 'Calcinha', value: 19.9, quantity: 3 })

    expect(fbq).toHaveBeenCalledWith('track', 'AddToCart', expect.objectContaining({ quantity: 3, content_ids: ['42'] }))
  })

  it('trackInitiateCheckout envia num_items e value agregados do carrinho', () => {
    const fbq = vi.fn()
    ;(window as any).fbq = fbq

    trackInitiateCheckout({ contentIds: ['1', '2'], value: 100, numItems: 5 })

    expect(fbq).toHaveBeenCalledWith('track', 'InitiateCheckout', {
      content_ids: ['1', '2'],
      value: 100,
      num_items: 5,
      currency: 'BRL',
    })
  })
})
