/** Status do pedido de atacado — módulo sem dependências de servidor (usável em client component). */
export const ORDER_STATUSES = ['pending', 'finalized', 'cancelled'] as const
export type WholesaleOrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_LABEL: Record<WholesaleOrderStatus, string> = {
  pending: 'Pendente',
  finalized: 'Finalizado',
  cancelled: 'Cancelado',
}
