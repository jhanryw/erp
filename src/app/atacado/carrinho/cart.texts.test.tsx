// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { CartProvider } from '../_lib/CartContext'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'
import { CarrinhoClient } from './CarrinhoClient'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const item = { variationId: 101, productId: 1, productName: 'Calcinha', sku: 'C', attributes: 'P', displayPrice: 100, quantity: 1, imageUrl: null, maxQuantity: 10 }
const reco = { productId: 2, name: 'Sutiã', brand: null, category: null, categorySlug: null, images: [], priceFrom: 50, purchasable: true,
  variations: [{ variationId: 201, sku: 'S', attributes: [], price: 50, available: true, lowStock: false, maxQuantity: 3 }] }

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith('/api/wholesale/recomendacoes')
      ? { products: [reco] }
      : { valid: true, items: [{ variationId: 101, ok: true, price: 100, availableQuantity: 5 }], summary: { subtotal: 100, minimumOrderAmount: 300, meetsMinimum: false, missingForMinimum: 200 } }),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(props: { minimumOrderNote?: string | null; addAlsoTitle?: string }) {
  localStorage.setItem('santtorini_wholesale_cart_v1', JSON.stringify([item]))
  return render(
    <WholesaleBasePathProvider basePath="">
      <CartProvider><CarrinhoClient minimumOrderAmount={300} {...props} /></CartProvider>
    </WholesaleBasePathProvider>,
  )
}

describe('textos configuráveis no carrinho', () => {
  it('padrões: título "Adicione também" e nenhuma nota de pedido mínimo', async () => {
    mount({})
    expect(await screen.findByRole('heading', { name: 'Adicione também' })).toBeTruthy()
    expect(screen.queryByText('Frete combinado')).toBeNull()
  })

  it('título e nota personalizados; a nota é só texto — o valor do mínimo continua o comercial', async () => {
    mount({ addAlsoTitle: 'Leve mais peças', minimumOrderNote: 'Mínimo de R$ 1,00 (texto livre)' })
    expect(await screen.findByRole('heading', { name: 'Leve mais peças' })).toBeTruthy()
    expect(screen.getByText('Mínimo de R$ 1,00 (texto livre)')).toBeTruthy()
    // regra comercial intacta: falta R$ 200 para os R$ 300 configurados, e o envio segue bloqueado
    await waitFor(() => expect(screen.getByText(/Faltam/).textContent).toMatch(/200,00/))
    expect((screen.getByRole('button', { name: /enviar pedido|atualizando/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('texto com HTML é exibido como texto, nunca interpretado', async () => {
    const { container } = mount({ minimumOrderNote: '<img src=x onerror=alert(1)><b>negrito</b>' })
    await screen.findByText(/negrito/)
    expect(container.querySelector('img[src="x"]')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })
})

describe('quantidades no carrinho — cliques rápidos', () => {
  it('vários cliques no mesmo lote somam todos, respeitando o estoque; chegar a 0 remove a linha', async () => {
    localStorage.setItem('santtorini_wholesale_cart_v1', JSON.stringify([{ ...item, quantity: 1, maxQuantity: 5 }]))
    render(
      <WholesaleBasePathProvider basePath="">
        <CartProvider><CarrinhoClient minimumOrderAmount={0} /></CartProvider>
      </WholesaleBasePathProvider>,
    )
    const plus = (await screen.findByRole('button', { name: /Aumentar Calcinha/ })) as HTMLButtonElement
    act(() => { for (let i = 0; i < 3; i++) plus.click() })
    expect(screen.getByText('4')).toBeTruthy()

    act(() => { for (let i = 0; i < 5; i++) plus.click() })
    expect(screen.getByText('5')).toBeTruthy() // teto = estoque

    const minus = screen.getByRole('button', { name: /Diminuir Calcinha/ }) as HTMLButtonElement
    act(() => { for (let i = 0; i < 5; i++) minus.click() })
    await waitFor(() => expect(screen.getByText('Seu carrinho está vazio.')).toBeTruthy())
  })
})
