// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { CartProvider } from '../_lib/CartContext'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'
import { CarrinhoClient } from './CarrinhoClient'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const CART_KEY = 'santtorini_wholesale_cart_v1'
const MINIMUM = 300

const cartItem = (over: Record<string, unknown> = {}) => ({
  variationId: 101, productId: 1, productName: 'Calcinha Renda', sku: 'CR-P', attributes: 'Preto · P',
  displayPrice: 100, quantity: 1, imageUrl: null, maxQuantity: 10, ...over,
})

function reco(productId: number, name: string, variations: Array<{ id: number; label: string; price: number; available?: boolean }>): WholesaleCatalogProduct {
  return {
    productId, name, brand: null, category: 'Cat', categorySlug: 'cat', images: [],
    variations: variations.map((v) => ({
      variationId: v.id, sku: `SKU-${v.id}`, attributes: [{ type: 'Tamanho', value: v.label }], price: v.price,
      available: v.available ?? true, lowStock: false, maxQuantity: v.available === false ? 0 : 5,
    })),
    priceFrom: Math.min(...variations.map((v) => v.price)), purchasable: true,
  }
}

let recommendations: WholesaleCatalogProduct[]
let fetchCalls: Array<{ url: string; init?: RequestInit }>
let orderResponse: { status: number; body: unknown }

function installFetch() {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init })
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })

    if (url.startsWith('/api/wholesale/cart/validate')) {
      const items = JSON.parse(String(init?.body)).items as Array<{ variationId: number; quantity: number }>
      const stored = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as Array<{ variationId: number; displayPrice: number }>
      const subtotal = items.reduce((s, i) => s + i.quantity * (stored.find((c) => c.variationId === i.variationId)?.displayPrice ?? 0), 0)
      return json({
        valid: true,
        items: items.map((i) => ({ variationId: i.variationId, ok: true, price: stored.find((c) => c.variationId === i.variationId)?.displayPrice ?? 0, availableQuantity: 10 })),
        summary: { subtotal, minimumOrderAmount: MINIMUM, meetsMinimum: subtotal >= MINIMUM, missingForMinimum: Math.max(0, MINIMUM - subtotal) },
      })
    }
    if (url.startsWith('/api/wholesale/recomendacoes')) return json({ products: recommendations })
    if (url.startsWith('/api/wholesale/orders')) return json(orderResponse.body, orderResponse.status)
    return json({}, 404)
  }))
}

function renderCart(items: unknown[]) {
  localStorage.setItem(CART_KEY, JSON.stringify(items))
  return render(
    <WholesaleBasePathProvider basePath="">
      <CartProvider><CarrinhoClient minimumOrderAmount={MINIMUM} /></CartProvider>
    </WholesaleBasePathProvider>,
  )
}

const money = (n: number) => new RegExp(n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, '\\s').replace('$', '\\$'))
const checkoutButton = () => screen.getByRole('button', { name: /finalizar pedido|atualizando|enviando/i }) as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  recommendations = [
    reco(2, 'Sutiã Bojo', [{ id: 201, label: 'M', price: 120 }]),
    reco(3, 'Body Liso', [{ id: 301, label: 'P', price: 80 }, { id: 302, label: 'G', price: 95 }, { id: 303, label: 'GG', price: 99, available: false }]),
  ]
  orderResponse = { status: 200, body: { order: { code: 'AT-0001', totalItems: 3, subtotal: 320 }, whatsappUrl: 'https://wa.me/5511999999999?text=pedido' } }
  installFetch()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('"Adicione também" no carrinho', () => {
  it('aparece com o título, pede ao servidor excluindo os PRODUTOS do carrinho e usa a seed da sessão', async () => {
    renderCart([cartItem(), cartItem({ variationId: 102, attributes: 'Preto · M' })]) // 2 variações do produto 1
    expect(await screen.findByRole('heading', { name: 'Adicione também' })).toBeTruthy()
    expect(screen.getByText('Sutiã Bojo')).toBeTruthy()

    const call = fetchCalls.find((c) => c.url.startsWith('/api/wholesale/recomendacoes'))!
    const qs = new URLSearchParams(call.url.split('?')[1])
    expect(qs.get('exclude')).toBe('1') // produto único, mesmo com 2 variações
    expect(qs.get('seed')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(qs.get('seed')).toBe(sessionStorage.getItem('santtorini_wholesale_reco_seed_v1')) // estável na sessão
  })

  it('defensivo: produto que já está no carrinho nunca aparece, mesmo se o servidor devolver', async () => {
    recommendations = [reco(1, 'Calcinha Renda (no carrinho)', [{ id: 101, label: 'P', price: 100 }]), ...recommendations]
    renderCart([cartItem()])
    await screen.findByText('Sutiã Bojo')
    expect(screen.queryByText('Calcinha Renda (no carrinho)')).toBeNull()
  })

  it('não mostra a seção com carrinho vazio nem sem recomendações', async () => {
    renderCart([])
    expect(screen.queryByText('Adicione também')).toBeNull()
    cleanup()

    recommendations = []
    renderCart([cartItem()])
    await waitFor(() => expect(fetchCalls.some((c) => c.url.startsWith('/api/wholesale/recomendacoes'))).toBe(true))
    expect(screen.queryByText('Adicione também')).toBeNull()
  })

  it('adicionar atualiza o total na hora e tira o produto da lista; o carrinho persiste', async () => {
    renderCart([cartItem()])
    const card = (await screen.findByText('Sutiã Bojo')).closest('li')!
    expect(screen.getAllByText(money(100)).length).toBeGreaterThan(0)

    fireEvent.click(within(card).getByRole('button', { name: /adicionar/i }))

    // o card (h3) some; o nome passa a existir só como linha do carrinho
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sutiã Bojo' })).toBeNull())
    expect(screen.getByText('Sutiã Bojo')).toBeTruthy()
    // subtotal estimado = 100 + 120
    expect(screen.getByText(money(220), { selector: 'dd' })).toBeTruthy()
    const saved = JSON.parse(localStorage.getItem(CART_KEY)!)
    expect(saved.map((i: any) => i.variationId)).toEqual([101, 201])
    expect(saved[1]).toMatchObject({ productId: 2, quantity: 1, displayPrice: 120 })
  })

  it('produto com variações: só as disponíveis aparecem e a escolhida é a que entra no carrinho', async () => {
    renderCart([cartItem()])
    const card = (await screen.findByText('Body Liso')).closest('li')!
    const money80 = (80).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ')
    const money95 = (95).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ')
    const select = within(card).getByRole('combobox') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => (o.textContent ?? '').replace(/\s/g, ' '))
    expect(labels).toEqual([`P — ${money80}`, `G — ${money95}`])
    expect(select.options).toHaveLength(2) // GG está indisponível → não é oferecida

    fireEvent.change(select, { target: { value: '302' } })
    expect(card.querySelector('p.font-semibold')!.textContent).toMatch(money(95)) // preço acompanha a variação
    fireEvent.click(within(card).getByRole('button', { name: /adicionar/i }))

    await waitFor(() => expect(JSON.parse(localStorage.getItem(CART_KEY)!).some((i: any) => i.variationId === 302)).toBe(true))
    const saved = JSON.parse(localStorage.getItem(CART_KEY)!)
    expect(saved.find((i: any) => i.variationId === 302)).toMatchObject({ productId: 3, displayPrice: 95, attributes: 'G' })
    expect(saved.some((i: any) => i.variationId === 301)).toBe(false)
  })
})

describe('pedido mínimo e finalização pelo WhatsApp', () => {
  it('abaixo do mínimo: aviso com o quanto falta e envio bloqueado; ao atingir, libera', async () => {
    renderCart([cartItem()]) // R$ 100 de R$ 300
    expect(await screen.findByText(/Faltam/)).toBeTruthy()
    await waitFor(() => expect(checkoutButton().disabled).toBe(true))
    expect(screen.getByText(/Faltam/).textContent).toMatch(money(200))

    // + Sutiã (120) → 220: ainda falta 80
    fireEvent.click(within((await screen.findByText('Sutiã Bojo')).closest('li')!).getByRole('button', { name: /adicionar/i }))
    await waitFor(() => expect(screen.getByText(/Faltam/).textContent).toMatch(money(80)))
    expect(checkoutButton().disabled).toBe(true)

    // + Body P (80) → 300: exatamente o mínimo libera
    fireEvent.click(within((await screen.findByText('Body Liso')).closest('li')!).getByRole('button', { name: /adicionar/i }))
    await waitFor(() => expect(screen.queryByText(/Faltam/)).toBeNull())
    expect(checkoutButton().disabled).toBe(false)
  })

  it('finaliza SEM pedir nome/WhatsApp: envia só id+quantidade, registra e abre o WhatsApp da loja', async () => {
    const location = { href: '' }
    Object.defineProperty(window, 'location', { configurable: true, value: location })

    renderCart([cartItem({ quantity: 3 })]) // 300 = mínimo
    await waitFor(() => expect(checkoutButton().disabled).toBe(false))

    // Nenhum campo de contato no carrinho
    expect(screen.queryByPlaceholderText('Seu nome')).toBeNull()
    expect(screen.queryByPlaceholderText(/Seu WhatsApp/)).toBeNull()

    fireEvent.click(checkoutButton())
    await waitFor(() => expect(location.href).toBe('https://wa.me/5511999999999?text=pedido'))

    const order = fetchCalls.find((c) => c.url === '/api/wholesale/orders')!
    const body = JSON.parse(String(order.init?.body))
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.customer).toBeUndefined()
    expect(body.items).toEqual([{ variation_id: 101, quantity: 3 }]) // nunca preço vindo do navegador
    expect(JSON.parse(localStorage.getItem(CART_KEY) ?? '[]')).toEqual([]) // carrinho limpo após registrar
  })

  it('duplo clique no botão não cria dois pedidos (mesma chave de idempotência, uma chamada em voo)', async () => {
    const location = { href: '' }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    renderCart([cartItem({ quantity: 3 })])
    await waitFor(() => expect(checkoutButton().disabled).toBe(false))
    const button = checkoutButton()
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(location.href).not.toBe(''))
    expect(fetchCalls.filter((c) => c.url === '/api/wholesale/orders')).toHaveLength(1)
  })

  it('se o servidor recusa por mínimo (422), não abre o WhatsApp', async () => {
    const location = { href: '' }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    orderResponse = { status: 422, body: { error: 'below_minimum', minimumOrder: 300, currentTotal: 250, missingAmount: 50 } }

    renderCart([cartItem({ quantity: 3 })])
    await waitFor(() => expect(checkoutButton().disabled).toBe(false))
    fireEvent.click(checkoutButton())

    await waitFor(() => expect(screen.getByText(/Faltam/)).toBeTruthy())
    expect(location.href).toBe('')
    expect(JSON.parse(localStorage.getItem(CART_KEY)!)).toHaveLength(1) // carrinho preservado
  })
})

describe('fallback quando o registro está limitado (429 rate_limited)', () => {
  const FALLBACK = {
    whatsappUrl: 'https://wa.me/5511999999999?text=PEDIDO%20ATACADO%20%E2%80%94%20AGUARDANDO',
    message: 'PEDIDO ATACADO — AGUARDANDO CONFIRMAÇÃO DA LOJA\nEste pedido ainda não foi registrado no sistema.',
    totalItems: 3, subtotal: 300,
  }
  const location = { href: '' }

  async function checkout() {
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    location.href = ''
    renderCart([cartItem({ quantity: 3 })])
    await waitFor(() => expect(checkoutButton().disabled).toBe(false))
    fireEvent.click(checkoutButton())
  }

  it('mostra aviso de pedido NÃO registrado, link do WhatsApp e preserva o carrinho — sem código nem sucesso', async () => {
    orderResponse = { status: 429, body: { error: 'rate_limited', message: 'Muitos pedidos', fallback: FALLBACK } }
    const fbq = vi.fn(); (window as any).fbq = fbq
    await checkout()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Seu pedido ainda não foi registrado')).toBeTruthy()
    const link = within(alert).getByRole('link', { name: /Continuar pelo WhatsApp/ }) as HTMLAnchorElement
    expect(link.href).toBe(FALLBACK.whatsappUrl)
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')

    expect(screen.queryByText(/Pedido AT-/)).toBeNull()                 // nenhum código exibido
    expect(screen.queryByRole('heading', { name: /Pedido .* registrado/ })).toBeNull() // sem tela de sucesso
    expect(location.href).toBe('')                                      // não navega sozinho
    expect(JSON.parse(localStorage.getItem(CART_KEY)!)).toHaveLength(1) // carrinho preservado
    expect(fbq).not.toHaveBeenCalled()                                  // sem evento de conversão
    delete (window as any).fbq
  })

  it('"Tentar registrar de novo" fecha o aviso e permite nova tentativa', async () => {
    orderResponse = { status: 429, body: { error: 'rate_limited', message: 'Muitos pedidos', fallback: FALLBACK } }
    await checkout()
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar registrar de novo' }))
    expect(screen.queryByRole('alert')).toBeNull()

    orderResponse = { status: 200, body: { order: { code: 'AT-0002', totalItems: 3, subtotal: 300 }, whatsappUrl: 'https://wa.me/5511999999999?text=ok' } }
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(location.href).toBe('https://wa.me/5511999999999?text=ok'))
  })

  it('URL de fallback que não é wa.me é IGNORADA (resposta nunca leva o cliente a um destino arbitrário)', async () => {
    orderResponse = { status: 429, body: { error: 'rate_limited', message: 'Muitos pedidos', fallback: { ...FALLBACK, whatsappUrl: 'https://evil.example/phish' } } }
    await checkout()
    await waitFor(() => expect(fetchCalls.some((c) => c.url === '/api/wholesale/orders')).toBe(true))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('a[href*="evil.example"]')).toBeNull()
  })

  it.each([
    ['estoque/preço (409)', 409, { error: 'items_unavailable', message: 'x', validation: { valid: false, items: [{ variationId: 101, ok: false, reason: 'insufficient_stock', price: 100, availableQuantity: 1 }], summary: { subtotal: 100, minimumOrderAmount: 300, meetsMinimum: false, missingForMinimum: 200 } }, fallback: FALLBACK }],
    ['abaixo do mínimo (422)', 422, { error: 'below_minimum', message: 'x', minimumOrder: 300, currentTotal: 250, missingAmount: 50, fallback: FALLBACK }],
    ['erro interno (500)', 500, { error: 'internal_error', message: 'x', fallback: FALLBACK }],
  ])('%s nunca mostra o fallback, mesmo que a resposta traga um', async (_name, status, body) => {
    orderResponse = { status, body }
    await checkout()
    await waitFor(() => expect(fetchCalls.some((c) => c.url === '/api/wholesale/orders')).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: /Continuar pelo WhatsApp/ })).toBeNull()
  })

  it('copiar mensagem: sucesso e falha do clipboard não quebram a tela', async () => {
    orderResponse = { status: 429, body: { error: 'rate_limited', message: 'Muitos pedidos', fallback: FALLBACK } }
    await checkout()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar mensagem' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FALLBACK.message))

    writeText.mockRejectedValueOnce(new Error('negado'))
    fireEvent.click(screen.getByRole('button', { name: 'Copiar mensagem' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toBeTruthy() // painel segue de pé; o link continua disponível
  })

  it('falha ao abrir o WhatsApp no fluxo normal: a tela de confirmação mantém o link "Abrir WhatsApp"', async () => {
    orderResponse = { status: 200, body: { order: { code: 'AT-0003', totalItems: 3, subtotal: 300 }, whatsappUrl: 'https://wa.me/5511999999999?text=ok' } }
    await checkout()
    const open = (await screen.findByRole('link', { name: /Abrir WhatsApp/ })) as HTMLAnchorElement
    expect(open.href).toBe('https://wa.me/5511999999999?text=ok')
    expect(screen.getByText(/Pedido AT-0003 registrado/)).toBeTruthy()
  })
})
