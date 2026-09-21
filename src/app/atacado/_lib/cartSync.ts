/**
 * Sincroniza o carrinho local (localStorage) com o resultado da validação do
 * SERVIDOR (`POST /api/wholesale/cart/validate`). Puro — sem I/O nem React —
 * pra ser usado ao ABRIR o carrinho e ao ENVIAR o pedido com a mesma regra.
 *
 *   ok                          → preço e estoque máximo atualizados
 *   estoque insuficiente (> 0)  → quantidade ajustada ao disponível
 *   sem estoque / removido do atacado / inativo / sem preço / inexistente → item removido
 *
 * Nunca aumenta quantidade e nunca confia no que o navegador guardou.
 */

import { formatCurrency } from '@/lib/utils/currency'
import type { CartItem } from './CartContext'

export type ValidationItem =
  | { variationId: number; ok: true; price: number; availableQuantity: number }
  | { variationId: number; ok: false; reason: 'not_found' | 'inactive' | 'not_enabled' | 'no_wholesale_price' | 'insufficient_stock'; price: number | null; availableQuantity: number }

export interface ValidationResponse {
  valid: boolean
  items: ValidationItem[]
  summary: { subtotal: number; minimumOrderAmount: number; meetsMinimum: boolean; missingForMinimum: number }
}

const REASON_LABEL: Record<string, string> = {
  not_found: 'não existe mais',
  inactive: 'não está mais disponível',
  not_enabled: 'não está mais disponível no atacado',
  no_wholesale_price: 'sem preço de atacado no momento',
  insufficient_stock: 'sem estoque',
}

function itemLabel(item: CartItem): string {
  return `${item.productName}${item.attributes ? ` (${item.attributes})` : ''}`
}

export function applyValidationToCart(items: CartItem[], validation: ValidationResponse): { items: CartItem[]; messages: string[] } {
  const byVariation = new Map(validation.items.map((v) => [v.variationId, v]))
  const next: CartItem[] = []
  const messages: string[] = []

  for (const item of items) {
    const result = byVariation.get(item.variationId)
    if (!result) { next.push(item); continue }

    if (result.ok) {
      if (Math.abs(result.price - item.displayPrice) > 0.004) {
        messages.push(`${itemLabel(item)}: preço atualizado de ${formatCurrency(item.displayPrice)} para ${formatCurrency(result.price)}.`)
      }
      next.push({ ...item, displayPrice: result.price, maxQuantity: result.availableQuantity })
      continue
    }

    if (result.reason === 'insufficient_stock' && result.availableQuantity > 0) {
      const quantity = Math.min(item.quantity, result.availableQuantity)
      messages.push(`${itemLabel(item)}: só há ${result.availableQuantity} un. disponíveis — quantidade ajustada.`)
      next.push({ ...item, quantity, maxQuantity: result.availableQuantity, displayPrice: result.price ?? item.displayPrice })
      continue
    }

    messages.push(`${itemLabel(item)}: ${REASON_LABEL[result.reason]} — removido do carrinho.`)
  }

  return { items: next, messages }
}
