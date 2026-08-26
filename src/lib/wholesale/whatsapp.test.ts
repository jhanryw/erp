import { describe, it, expect } from 'vitest'
import { buildWhatsAppOrderMessage, buildWhatsAppContactUrl } from './whatsapp'
import { formatCurrency } from '@/lib/utils/currency'

const ITEM = { productName: 'Calcinha Fio', attributes: 'P', quantity: 2, unitPrice: 10 }

describe('buildWhatsAppOrderMessage', () => {
  it('null quando não há itens', () => {
    expect(buildWhatsAppOrderMessage([], '84999998888')).toBeNull()
  })

  it('null quando o telefone não é um WhatsApp BR válido', () => {
    expect(buildWhatsAppOrderMessage([ITEM], '123')).toBeNull()
    expect(buildWhatsAppOrderMessage([ITEM], null)).toBeNull()
    expect(buildWhatsAppOrderMessage([ITEM], undefined)).toBeNull()
  })

  it('usa o displayName configurado na saudação', () => {
    const order = buildWhatsAppOrderMessage([ITEM], '84999998888', 'Loja Exemplo')
    expect(order?.message).toContain('no atacado da Loja Exemplo')
  })

  it('cai no texto genérico quando não há displayName configurado', () => {
    const order = buildWhatsAppOrderMessage([ITEM], '84999998888', null)
    expect(order?.message).toBe(
      [
        'Olá! Gostaria de fazer este pedido:',
        '',
        'Calcinha Fio',
        `P — 2 un. × ${formatCurrency(10)}`,
        `Subtotal: ${formatCurrency(20)}`,
        '',
        'Total de unidades: 2',
        `Total do pedido: ${formatCurrency(20)}`,
      ].join('\n'),
    )
  })

  it('soma totais e agrupa por produto preservando ordem', () => {
    const order = buildWhatsAppOrderMessage(
      [
        { productName: 'A', attributes: 'P', quantity: 1, unitPrice: 10 },
        { productName: 'B', attributes: 'M', quantity: 2, unitPrice: 5 },
        { productName: 'A', attributes: 'M', quantity: 3, unitPrice: 10 },
      ],
      '84999998888',
    )
    expect(order?.totalUnits).toBe(6)
    expect(order?.totalValue).toBe(50)
    const lines = order!.message.split('\n')
    expect(lines.indexOf('A')).toBeLessThan(lines.indexOf('B'))
  })

  it('monta a URL wa.me com o texto codificado', () => {
    const order = buildWhatsAppOrderMessage([ITEM], '84999998888')
    expect(order?.url).toMatch(/^https:\/\/wa\.me\/5584999998888\?text=/)
  })

  it('omite o prefixo de atributos quando a variação não tem atributo', () => {
    const order = buildWhatsAppOrderMessage([{ ...ITEM, attributes: '' }], '84999998888')
    expect(order?.message).toContain(`2 un. × ${formatCurrency(10)}`)
    expect(order?.message).not.toContain('— 2 un.')
  })
})

describe('buildWhatsAppContactUrl', () => {
  it('null quando o telefone não é válido', () => {
    expect(buildWhatsAppContactUrl(null, 'oi')).toBeNull()
    expect(buildWhatsAppContactUrl('123', 'oi')).toBeNull()
  })

  it('monta a URL com a mensagem informada', () => {
    const url = buildWhatsAppContactUrl('84999998888', 'Olá!')
    expect(url).toBe('https://wa.me/5584999998888?text=Ol%C3%A1!')
  })
})
