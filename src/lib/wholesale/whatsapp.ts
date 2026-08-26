/**
 * Geração da mensagem de pedido do catálogo de atacado (seção 13 do
 * pedido) — módulo puro, sem I/O. Reaproveita `normalizePhoneBR` (já
 * usado pelo CRM/Customer Identity) pro número configurado em
 * `wholesale_site_settings.whatsapp_phone` — nunca uma segunda lógica de
 * normalização de telefone.
 */

import { normalizePhoneBR } from '@/lib/utils/phone'
import { formatCurrency } from '@/lib/utils/currency'

export interface WhatsAppCartItem {
  productName: string
  /** "" quando o produto não tem variante (seção 9 do pedido) — nunca omitido, só vazio. */
  attributes: string
  quantity: number
  unitPrice: number
}

export interface WhatsAppOrderMessage {
  message: string
  /** Link wa.me pronto, com o texto já URL-encoded. */
  url: string
  totalUnits: number
  totalValue: number
}

/**
 * `null` quando não há itens ou o telefone configurado não é um WhatsApp
 * brasileiro válido — quem chama decide o que mostrar (nunca abre um
 * wa.me quebrado).
 */
export function buildWhatsAppOrderMessage(
  items: WhatsAppCartItem[],
  whatsappPhoneRaw: string | null | undefined,
  /** `wholesale_site_settings.display_name` — nunca um nome de empresa fixo no código (seção 9 do pedido: tudo isolado por empresa). `null`/vazio cai no texto genérico "no atacado". */
  displayName?: string | null,
): WhatsAppOrderMessage | null {
  if (items.length === 0) return null

  const phone = normalizePhoneBR(whatsappPhoneRaw)
  if (!phone.ok) return null

  // Agrupa por produto, preservando a ordem em que apareceram no carrinho.
  const groups = new Map<string, WhatsAppCartItem[]>()
  for (const item of items) {
    const list = groups.get(item.productName) ?? []
    list.push(item)
    groups.set(item.productName, list)
  }

  const greeting = displayName
    ? `Olá! Gostaria de fazer este pedido no atacado da ${displayName}:`
    : 'Olá! Gostaria de fazer este pedido:'
  const lines: string[] = [greeting, '']
  let totalUnits = 0
  let totalValue = 0

  for (const [productName, groupItems] of groups) {
    lines.push(productName)
    let subtotal = 0
    for (const item of groupItems) {
      const lineTotal = item.quantity * item.unitPrice
      subtotal += lineTotal
      totalUnits += item.quantity
      totalValue += lineTotal
      const prefix = item.attributes ? `${item.attributes} — ` : ''
      lines.push(`${prefix}${item.quantity} un. × ${formatCurrency(item.unitPrice)}`)
    }
    lines.push(`Subtotal: ${formatCurrency(subtotal)}`)
    lines.push('')
  }

  lines.push(`Total de unidades: ${totalUnits}`)
  lines.push(`Total do pedido: ${formatCurrency(totalValue)}`)

  const message = lines.join('\n').trim()

  return {
    message,
    url: buildWhatsAppUrl(phone.e164, message),
    totalUnits,
    totalValue,
  }
}

/**
 * Link wa.me genérico (fora do fluxo de pedido) — usado quando o catálogo
 * está desativado (seção 26 do pedido: "botão de WhatsApp, se configurado").
 * `null` quando o telefone configurado não é um WhatsApp brasileiro válido.
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
