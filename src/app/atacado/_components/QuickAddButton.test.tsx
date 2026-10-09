// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CartProvider, useCart } from '../_lib/CartContext'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'
import { QuickAddButton } from './QuickAddButton'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const product = (variations: Array<{ id: number; price: number; available?: boolean }>, purchasable = true): WholesaleCatalogProduct => ({
  productId: 9, name: 'Body', brand: null, category: null, categorySlug: null, images: [{ url: 'https://cdn.test/b.jpg', alt: null }],
  variations: variations.map((v) => ({ variationId: v.id, sku: `S${v.id}`, attributes: [], price: v.price, available: v.available ?? true, lowStock: false, maxQuantity: v.available === false ? 0 : 4 })),
  priceFrom: 50, purchasable,
})

function Totals() {
  const { totalItems, totalDisplayValue } = useCart()
  return <output data-testid="totals">{totalItems}|{totalDisplayValue}</output>
}
const mount = (p: WholesaleCatalogProduct) =>
  render(<WholesaleBasePathProvider basePath=""><CartProvider><QuickAddButton product={p} basePath="" /><Totals /></CartProvider></WholesaleBasePathProvider>)

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('QuickAddButton', () => {
  it('uma variação comprável: adiciona direto e atualiza os totais', () => {
    mount(product([{ id: 1, price: 50 }, { id: 2, price: 60, available: false }]))
    fireEvent.click(screen.getByRole('button', { name: /adicionar/i }))
    expect(screen.getByTestId('totals').textContent).toBe('1|50')
    fireEvent.click(screen.getByRole('button', { name: /adicionar/i }))
    expect(screen.getByTestId('totals').textContent).toBe('2|100')
  })

  it('várias variações: leva à página do produto em vez de escolher por conta própria', () => {
    mount(product([{ id: 1, price: 50 }, { id: 2, price: 60 }]))
    expect(screen.queryByRole('button', { name: /adicionar/i })).toBeNull()
    expect(screen.getByRole('link', { name: /escolher opções/i }).getAttribute('href')).toBe('/produto/9')
  })

  it('produto indisponível: nada para adicionar', () => {
    const { container } = mount(product([{ id: 1, price: 50, available: false }], false))
    expect(container.querySelector('button, a')).toBeNull()
  })
})
