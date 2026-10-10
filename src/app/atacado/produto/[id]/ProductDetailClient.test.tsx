// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import { CartProvider, useCart } from '../../_lib/CartContext'
import { WholesaleBasePathProvider } from '../../_lib/WholesaleBasePathContext'
import { ProductDetailClient } from './ProductDetailClient'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// Sem imagem remota: <img> nativo, para o teste focar na lógica.
vi.mock('../../_components/CatalogImage', () => ({
  CatalogImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))

const v = (id: number, size: string, price: number, max: number, available = true) => ({
  variationId: id, sku: `SKU${id}`, attributes: [{ type: 'Cor', value: 'x' }, { type: 'Tamanho', value: size }],
  price, available, lowStock: false, maxQuantity: available ? max : 0,
})
const color = (id: number, label: string, variations: ReturnType<typeof v>[]): WholesaleCatalogProduct => ({
  productId: id, name: `Calcinha Invisible ${label}`, brand: null, category: 'Calcinha', categorySlug: 'calcinha', colorLabel: label,
  images: [{ url: `https://img/${label}.jpg`, alt: null }], variations, priceFrom: 20, purchasable: variations.some((x) => x.available), family: [],
})

const rosa = color(1, 'Rosa', [v(11, 'P/M', 20, 5), v(12, 'G/GG', 22, 2)])
const preto = color(2, 'Preto', [v(21, 'P/M', 20, 10), v(22, 'G/GG', 24, 0, false)])
const branco = color(3, 'Branco', [v(31, 'P/M', 20, 0, false)]) // sem estoque
const product = { ...rosa, family: [preto, branco] }

function Cart() {
  const { items, totalItems, totalDisplayValue } = useCart()
  return <output data-testid="cart">{JSON.stringify({ n: totalItems, total: totalDisplayValue, lines: items.map((i) => [i.variationId, i.productId, i.productName, i.quantity, i.imageUrl]) })}</output>
}
const cart = () => JSON.parse(screen.getByTestId('cart').textContent!)

function mount(p = product) {
  return render(
    <WholesaleBasePathProvider basePath="">
      <CartProvider><ProductDetailClient product={p} /><Cart /></CartProvider>
    </WholesaleBasePathProvider>,
  )
}
const inc = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Aumentar ${label}` }))

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('página do produto — várias cores na mesma compra', () => {
  it('mostra as cores com miniatura e nome; a indisponível aparece como indisponível', () => {
    mount()
    const colors = screen.getByRole('region', { name: 'Cores' })
    expect(within(colors).getAllByRole('button')).toHaveLength(3)
    expect(within(colors).getByRole('button', { name: /Branco — indisponível/ })).toBeTruthy()
    expect(within(colors).getByRole('button', { name: 'Rosa' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('alternar de cor mantém as quantidades das outras e soma peças e subtotal', () => {
    mount()
    inc('Rosa P/M'); inc('Rosa P/M') // 2 x 20
    fireEvent.click(screen.getByRole('button', { name: /^Preto/ }))
    expect(screen.getByRole('heading', { name: /Preto/ })).toBeTruthy()
    expect((screen.getByRole('img', { name: /Preto/ }) as HTMLImageElement).src).toContain('Preto.jpg') // imagem da cor escolhida
    inc('Preto P/M'); inc('Preto P/M'); inc('Preto P/M') // 3 x 20

    expect(screen.getByText(/5 peças selecionadas em 2 cores/)).toBeTruthy()
    expect(screen.getByText(/R\$\s*100,00/)).toBeTruthy()

    // volta para Rosa: as 2 peças continuam lá
    fireEvent.click(screen.getByRole('button', { name: /^Rosa/ }))
    expect(within(screen.getByRole('group', { name: 'Quantidade de Rosa P/M' })).getByText('2')).toBeTruthy()
  })

  it('não ultrapassa o estoque e bloqueia tamanho indisponível', () => {
    mount()
    for (let i = 0; i < 9; i++) inc('Rosa G/GG') // estoque 2
    expect(within(screen.getByRole('group', { name: 'Quantidade de Rosa G/GG' })).getByText('2')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Aumentar Rosa G/GG' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^Preto/ }))
    expect((screen.getByRole('button', { name: 'Aumentar Preto G/GG' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('uma única ação adiciona todas as combinações, cada uma com a cor/foto certa, e limpa a seleção', () => {
    mount()
    inc('Rosa P/M'); inc('Rosa G/GG')
    fireEvent.click(screen.getByRole('button', { name: /^Preto/ }))
    inc('Preto P/M'); inc('Preto P/M')

    fireEvent.click(screen.getByRole('button', { name: /Adicionar 4 peças ao carrinho/ }))

    const c = cart()
    expect(c.n).toBe(4)
    expect(c.total).toBe(20 + 22 + 2 * 20)
    expect(c.lines).toEqual([
      [11, 1, 'Calcinha Invisible Rosa', 1, 'https://img/Rosa.jpg'],
      [12, 1, 'Calcinha Invisible Rosa', 1, 'https://img/Rosa.jpg'],
      [21, 2, 'Calcinha Invisible Preto', 2, 'https://img/Preto.jpg'],
    ])
    expect(screen.getByText('Nenhuma peça selecionada')).toBeTruthy()
  })

  it('cliques rápidos (vários antes de um novo render) não perdem incrementos e respeitam o estoque', () => {
    mount()
    const plus = screen.getByRole('button', { name: 'Aumentar Rosa P/M' }) as HTMLButtonElement
    act(() => { for (let i = 0; i < 4; i++) plus.click() }) // estoque 5: 4 cliques no MESMO lote
    expect(within(screen.getByRole('group', { name: 'Quantidade de Rosa P/M' })).getByText('4')).toBeTruthy()

    act(() => { for (let i = 0; i < 4; i++) plus.click() }) // tenta passar de 5
    expect(within(screen.getByRole('group', { name: 'Quantidade de Rosa P/M' })).getByText('5')).toBeTruthy()

    const minus = screen.getByRole('button', { name: 'Diminuir Rosa P/M' }) as HTMLButtonElement
    act(() => { for (let i = 0; i < 3; i++) minus.click() })
    expect(within(screen.getByRole('group', { name: 'Quantidade de Rosa P/M' })).getByText('2')).toBeTruthy()
  })

  it('sem seleção o botão não promete adicionar nada e não altera o carrinho', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Escolha as quantidades' }))
    expect(cart().n).toBe(0)
  })

  it('produto sem grupo: sem seletor de cores, fluxo simples continua igual', () => {
    mount({ ...rosa, family: [] })
    expect(screen.queryByRole('region', { name: 'Cores' })).toBeNull()
    inc('Rosa P/M')
    fireEvent.click(screen.getByRole('button', { name: /Adicionar 1 peça ao carrinho/ }))
    expect(cart().lines).toEqual([[11, 1, 'Calcinha Invisible Rosa', 1, 'https://img/Rosa.jpg']])
  })

  it('o mesmo produto adicionado duas vezes soma na mesma linha (sem duplicar item)', () => {
    mount()
    inc('Rosa P/M')
    fireEvent.click(screen.getByRole('button', { name: /Adicionar 1 peça/ }))
    inc('Rosa P/M')
    fireEvent.click(screen.getByRole('button', { name: /Adicionar 1 peça/ }))
    expect(cart().lines).toEqual([[11, 1, 'Calcinha Invisible Rosa', 2, 'https://img/Rosa.jpg']])
  })
})
