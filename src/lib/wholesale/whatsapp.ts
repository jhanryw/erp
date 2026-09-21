/**
 * Mensagem de WhatsApp do pedido de atacado — módulo puro, sem I/O.
 *
 * A mensagem é gerada a partir do PEDIDO PERSISTIDO (snapshot gravado pelo
 * servidor: nome, SKU, atributos, quantidade, preço, totais, código) —
 * nunca do carrinho do navegador. `normalizePhoneBR` (mesmo do CRM) valida o
 * número da EMPRESA (`wholesale_site_settings.whatsapp_phone`); o telefone do
 * comprador é só dado do pedido, nunca o destino.
 */

import { normalizePhoneBR } from '@/lib/utils/phone'
import { formatCurrency } from '@/lib/utils/currency'

export interface WhatsAppOrderItem {
  productName: string
  sku: string
  attributes: { type: string; value: string }[]
  quantity: number
  unitPrice: number
  subtotal: number
}

export interface WhatsAppOrder {
  code: string
  customerName: string
  /** E.164 (ex.: +5584999999999). */
  customerPhone: string
  totalItems: number
  subtotal: number
  items: WhatsAppOrderItem[]
}

export interface WhatsAppOrderMessage {
  message: string
  /** Link wa.me pronto, com o texto já URL-encoded. */
  url: string
}

/** `+5584999999999` → `(84) 99999-9999`; formato desconhecido volta como veio. */
export function formatPhoneBR(e164: string): string {
  const digits = e164.replace(/\D/g, '').replace(/^55/, '')
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
  return e164
}

// Intl usa espaço não-quebrável (U+00A0) em "R$ 39,90" — no texto do WhatsApp fica um espaço comum.
const money = (value: number) => formatCurrency(value).replace(/ /g, ' ')

/** `null` quando o WhatsApp da empresa não é um número brasileiro válido (nunca gera wa.me quebrado). */
export function buildOrderWhatsAppMessage(order: WhatsAppOrder, companyWhatsappRaw: string | null | undefined): WhatsAppOrderMessage | null {
  const company = normalizePhoneBR(companyWhatsappRaw)
  if (!company.ok || order.items.length === 0) return null

  const lines: string[] = [
    `PEDIDO ATACADO — ${order.code}`,
    `Cliente: ${order.customerName}`,
    `WhatsApp: ${formatPhoneBR(order.customerPhone)}`,
    '',
  ]

  order.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.productName}`)
    if (item.sku) lines.push(`SKU: ${item.sku}`)
    for (const attr of item.attributes) {
      if (!attr.value) continue // nunca mostra campo vazio
      lines.push(attr.type ? `${attr.type}: ${attr.value}` : attr.value)
    }
    lines.push(`${item.quantity} un. × ${money(item.unitPrice)}`)
    lines.push(`Subtotal: ${money(item.subtotal)}`)
  })

  lines.push('', `Total de peças: ${order.totalItems}`, `Total do pedido: ${money(order.subtotal)}`, `Código do pedido: ${order.code}`)

  const message = lines.join('\n')
  return { message, url: buildWhatsAppUrl(company.e164, message) }
}

/**
 * Link wa.me genérico (fora do fluxo de pedido) — catálogo desativado
 * (botão "Falar pelo WhatsApp") e contato da equipe com o cliente.
 * `null` quando o telefone não é um WhatsApp brasileiro válido.
 */
export function buildWhatsAppContactUrl(whatsappPhoneRaw: string | null | undefined, message: string): string | null {
  const phone = normalizePhoneBR(whatsappPhoneRaw)
  if (!phone.ok) return null
  return buildWhatsAppUrl(phone.e164, message)
}

function buildWhatsAppUrl(phoneE164: string, message: string): string {
  const phoneDigits = phoneE164.replace('+', '')
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`
}
