// Comprovante não fiscal / trocas — elegibilidade de troca por item.
//
// Fluxo vivo confirmado por auditoria: exchanges + exchange_items
// (supabase/migrations/20260609_exchanges.sql). returns/return_items não
// existem como tabela — "returns" em sellerDashboard.ts é uma contagem de
// sales.status='returned', não um fluxo próprio — por isso não entram aqui.
//
// Mesma fórmula já usada (inline) em
// src/app/(dashboard)/vendas/[id]/troca/page.tsx:112-123 — extraída aqui
// como função pura e testável para o comprovante, sem tocar no arquivo
// original (fluxo já em produção, preservado como está).

export interface SaleItemForEligibility {
  id: number
  quantity: number
}

export interface ExchangeItemForEligibility {
  sale_item_id: number
  quantity_returned: number
}

export interface ItemEligibility {
  sale_item_id: number
  quantity_purchased: number
  already_returned: number
  available_to_return: number
}

export function computeExchangeEligibility(
  items: SaleItemForEligibility[],
  exchangeItems: ExchangeItemForEligibility[],
): ItemEligibility[] {
  const alreadyReturned = new Map<number, number>()
  for (const ei of exchangeItems) {
    alreadyReturned.set(
      ei.sale_item_id,
      (alreadyReturned.get(ei.sale_item_id) ?? 0) + ei.quantity_returned,
    )
  }

  return items.map((item) => {
    const returned = alreadyReturned.get(item.id) ?? 0
    return {
      sale_item_id: item.id,
      quantity_purchased: item.quantity,
      already_returned: returned,
      available_to_return: Math.max(0, item.quantity - returned),
    }
  })
}
