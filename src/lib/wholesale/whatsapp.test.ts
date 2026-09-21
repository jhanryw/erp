import { describe, it, expect } from 'vitest'
import { buildOrderWhatsAppMessage, buildWhatsAppContactUrl, formatPhoneBR, type WhatsAppOrder } from './whatsapp'

const ORDER: WhatsAppOrder = {
  code: 'AT-000184',
  customerName: 'Maria Silva',
  customerPhone: '+5584999999999',
  totalItems: 5,
  subtotal: 154.5,
  items: [
    { productName: 'Conjunto Nuance', sku: 'NUA-M-PRETO', attributes: [{ type: 'Tamanho', value: 'M' }, { type: 'Cor', value: 'Preto' }], quantity: 2, unitPrice: 39.9, subtotal: 79.8 },
    { productName: 'Sutiã Reforçado', sku: 'SR-G-BEGE', attributes: [{ type: 'Tamanho', value: 'G' }, { type: 'Cor', value: 'Bege' }], quantity: 3, unitPrice: 24.9, subtotal: 74.7 },
  ],
}
const COMPANY = '84988887777'

describe('buildOrderWhatsAppMessage (a partir do pedido persistido)', () => {
  it('gera o formato completo: código, cliente, SKU, atributos, quantidades, subtotais e totais', () => {
    const r = buildOrderWhatsAppMessage(ORDER, COMPANY)!
    expect(r.message).toBe([
      'PEDIDO ATACADO — AT-000184',
      'Cliente: Maria Silva',
      'WhatsApp: (84) 99999-9999',
      '',
      '1. Conjunto Nuance',
      'SKU: NUA-M-PRETO',
      'Tamanho: M',
      'Cor: Preto',
      '2 un. × R$ 39,90',
      'Subtotal: R$ 79,80',
      '2. Sutiã Reforçado',
      'SKU: SR-G-BEGE',
      'Tamanho: G',
      'Cor: Bege',
      '3 un. × R$ 24,90',
      'Subtotal: R$ 74,70',
      '',
      'Total de peças: 5',
      'Total do pedido: R$ 154,50',
      'Código do pedido: AT-000184',
    ].join('\n'))
  })

  it('usa os totais persistidos do pedido (não recalcula a partir de outra fonte)', () => {
    const r = buildOrderWhatsAppMessage({ ...ORDER, totalItems: 99, subtotal: 1234.56 }, COMPANY)!
    expect(r.message).toContain('Total de peças: 99')
    expect(r.message).toContain('Total do pedido: R$ 1.234,56')
  })

  it('o destino é o WhatsApp da EMPRESA, nunca o telefone do comprador', () => {
    const r = buildOrderWhatsAppMessage(ORDER, COMPANY)!
    expect(r.url.startsWith('https://wa.me/5584988887777?text=')).toBe(true)
    expect(r.url).not.toMatch(/wa\.me\/5584999999999/)
  })

  it('texto é URL-encoded corretamente (acentos, quebras de linha, símbolos) e decodifica de volta idêntico', () => {
    const r = buildOrderWhatsAppMessage({ ...ORDER, customerName: 'José & Cia #1 100%' }, COMPANY)!
    const encoded = r.url.split('?text=')[1]
    expect(encoded).not.toMatch(/[\n &#]/)
    expect(decodeURIComponent(encoded)).toBe(r.message)
    expect(r.message).toContain('José & Cia #1 100%')
  })

  it('não mostra campos vazios (atributo sem valor, sem SKU)', () => {
    const r = buildOrderWhatsAppMessage({
      ...ORDER,
      items: [{ productName: 'Body', sku: '', attributes: [{ type: 'Cor', value: '' }, { type: '', value: 'Único' }], quantity: 1, unitPrice: 10, subtotal: 10 }],
    }, COMPANY)!
    expect(r.message).toContain('1. Body\nÚnico\n1 un. × R$ 10,00')
    expect(r.message).not.toMatch(/SKU:|Cor:/)
  })

  it('null quando o WhatsApp da empresa é inválido ou o pedido não tem itens', () => {
    expect(buildOrderWhatsAppMessage(ORDER, '123')).toBeNull()
    expect(buildOrderWhatsAppMessage(ORDER, null)).toBeNull()
    expect(buildOrderWhatsAppMessage({ ...ORDER, items: [] }, COMPANY)).toBeNull()
  })

  it('sem espaço não-quebrável (U+00A0) no texto', () => {
    expect(buildOrderWhatsAppMessage(ORDER, COMPANY)!.message).not.toContain(' ')
  })
})

describe('formatPhoneBR / buildWhatsAppContactUrl', () => {
  it('formata celular e fixo', () => {
    expect(formatPhoneBR('+5584999999999')).toBe('(84) 99999-9999')
    expect(formatPhoneBR('+558433221100')).toBe('(84) 3322-1100')
  })
  it('contato genérico: URL válida ou null', () => {
    expect(buildWhatsAppContactUrl('84999998888', 'Olá! Tudo bem?')).toBe(`https://wa.me/5584999998888?text=${encodeURIComponent('Olá! Tudo bem?')}`)
    expect(buildWhatsAppContactUrl('abc', 'x')).toBeNull()
  })
})
