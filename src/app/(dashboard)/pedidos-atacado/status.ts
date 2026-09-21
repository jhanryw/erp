import type { WholesaleOrderStatus } from '@/services/wholesale/orderStatus'

export const ORDER_STATUS_VARIANT: Record<WholesaleOrderStatus, 'warning' | 'success' | 'secondary'> = {
  pending: 'warning',
  finalized: 'success',
  cancelled: 'secondary',
}
