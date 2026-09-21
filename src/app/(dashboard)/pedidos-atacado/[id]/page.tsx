import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import { buildWhatsAppContactUrl, formatPhoneBR } from '@/lib/wholesale/whatsapp'
import { getWholesaleOrder } from '@/services/wholesale/ordersAdmin'
import { ORDER_STATUS_LABEL } from '@/services/wholesale/orderStatus'
import { ORDER_STATUS_VARIANT } from '../status'
import { OrderActions } from './order-actions'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PedidoAtacadoPage({ params }: { params: { id: string } }) {
  const profile = await requirePageRole('usuario')
  if (!profile.company_id || !UUID.test(params.id)) notFound()

  // Escopado pela empresa da sessão: pedido de outra empresa é "não encontrado".
  const order = await getWholesaleOrder(createAdminClient() as any, profile.company_id, params.id)
  if (!order) notFound()

  // "Abrir WhatsApp" = conversa da EQUIPE com o comprador, sobre este pedido registrado.
  const whatsappUrl = buildWhatsAppContactUrl(
    order.customerPhone,
    `Olá, ${order.customerName}! Sobre o seu pedido de atacado ${order.code} (${order.totalItems} peça${order.totalItems !== 1 ? 's' : ''}, ${formatCurrency(order.subtotal).replace(/ /g, ' ')}).`,
  )

  return (
    <div className="space-y-6">
      <Link href="/pedidos-atacado" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="h-4 w-4" /> Pedidos de atacado
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight font-mono">{order.code}</h1>
          <p className="text-sm text-text-muted">{formatDateTime(order.createdAt)}</p>
        </div>
        <Badge variant={ORDER_STATUS_VARIANT[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Badge>
      </div>

      <OrderActions orderId={order.id} status={order.status} whatsappUrl={whatsappUrl} />

      <Card>
        <CardHeader className="text-sm font-semibold">Cliente</CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div><span className="text-text-muted">Nome: </span>{order.customerName}</div>
          <div><span className="text-text-muted">Telefone: </span>{formatPhoneBR(order.customerPhone)}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-semibold">Itens (registrados no momento do pedido)</CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Atributos</TableHead>
                <TableHead className="text-right">Qtd.</TableHead>
                <TableHead className="text-right">Preço unit.</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((i) => (
                <TableRow key={i.position}>
                  <TableCell className="font-medium">{i.productName}</TableCell>
                  <TableCell><code>{i.sku}</code></TableCell>
                  <TableCell>{i.attributes.map((a) => (a.type ? `${a.type}: ${a.value}` : a.value)).join(' · ') || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(i.unitPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(i.subtotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <CardContent className="space-y-1 border-t border-border text-sm">
          <div className="flex justify-between"><span className="text-text-muted">Total de peças</span><span className="tabular-nums">{order.totalItems}</span></div>
          <div className="flex justify-between font-semibold"><span>Total do pedido</span><span className="tabular-nums">{formatCurrency(order.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Pedido mínimo aplicado</span><span className="tabular-nums">{formatCurrency(order.minimumOrderAmount)}</span></div>
        </CardContent>
      </Card>
    </div>
  )
}
