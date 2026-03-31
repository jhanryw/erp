import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const token = request.headers.get('x-nuvemshop-token')
  if (!token || token !== process.env.NUVEMSHOP_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  try {
    const admin = createAdminClient()

    const externalId       = String(body.id ?? '')
    const channelStatus    = String(body.status ?? '')          // valor real da Nuvemshop
    const operationalStatus = channelStatus === 'paid'          // status interno do ERP
      ? 'pronto'
      : null
    const total            = Number(body.total ?? 0)
    const customer         = (body.customer ?? {}) as Record<string, unknown>
    const customerName     = String(customer.name ?? '')
    const customerEmail    = String(customer.email ?? '')
    const products         = Array.isArray(body.products)
      ? (body.products as Record<string, unknown>[])
      : []

    // ── Verificar se pedido já existe ──────────────────────────────────────────
    const { data: existing } = await (admin as any)
      .from('pedidos')
      .select('id')
      .eq('external_id', externalId)
      .eq('source', 'nuvemshop')
      .maybeSingle() as { data: { id: number } | null }

    if (existing) {
      // ── UPDATE ────────────────────────────────────────────────────────────────
      const updatePayload: Record<string, unknown> = {
        status:         channelStatus,      // mantém o status do canal sem sobrescrever
        channel_status: channelStatus,
        total,
        customer_name:  customerName,
        customer_email: customerEmail,
      }
      // só seta operational_status quando o canal indica pagamento confirmado
      if (operationalStatus) updatePayload.operational_status = operationalStatus

      const { error: updateError } = await (admin as any)
        .from('pedidos')
        .update(updatePayload)
        .eq('id', existing.id) as { error: { message: string } | null }

      if (updateError) {
        console.error('[webhook/nuvemshop/order] Erro ao atualizar pedido', updateError.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }

      // ── Substituição idempotente dos itens ────────────────────────────────────
      if (products.length > 0) {
        const { error: deleteError } = await (admin as any)
          .from('pedidos_itens')
          .delete()
          .eq('pedido_id', existing.id) as { error: { message: string } | null }

        if (deleteError) {
          console.error('[webhook/nuvemshop/order] Erro ao remover itens antigos', deleteError.message)
          return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
        }

        const itens = products.map((p) => ({
          pedido_id:           existing.id,
          external_product_id: String(p.product_id ?? p.id ?? ''),
          nome:                String(p.name ?? ''),
          quantidade:          Number(p.quantity ?? 1),
          preco:               Number(p.price ?? 0),
        }))

        const { error: itensError } = await (admin as any)
          .from('pedidos_itens')
          .insert(itens) as { error: { message: string } | null }

        if (itensError) {
          console.error('[webhook/nuvemshop/order] Erro ao reinserir itens', itensError.message)
          return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
        }
      }

      return NextResponse.json({ ok: true, pedido_id: existing.id, updated: true })
    }

    // ── INSERT: criar novo pedido ──────────────────────────────────────────────
    const { data: pedido, error: pedidoError } = await (admin as any)
      .from('pedidos')
      .insert({
        external_id:        externalId,
        source:             'nuvemshop',
        status:             channelStatus,
        channel_status:     channelStatus,
        operational_status: operationalStatus,
        total,
        customer_name:      customerName,
        customer_email:     customerEmail,
      })
      .select('id')
      .single() as { data: { id: number } | null; error: { message: string } | null }

    if (pedidoError || !pedido) {
      console.error('[webhook/nuvemshop/order] Erro ao inserir pedido', pedidoError?.message)
      return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
    }

    // ── Inserir itens ─────────────────────────────────────────────────────────
    if (products.length > 0) {
      const itens = products.map((p) => ({
        pedido_id:           pedido.id,
        external_product_id: String(p.product_id ?? p.id ?? ''),
        nome:                String(p.name ?? ''),
        quantidade:          Number(p.quantity ?? 1),
        preco:               Number(p.price ?? 0),
      }))

      const { error: itensError } = await (admin as any)
        .from('pedidos_itens')
        .insert(itens) as { error: { message: string } | null }

      if (itensError) {
        console.error('[webhook/nuvemshop/order] Erro ao inserir itens', itensError.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true, pedido_id: pedido.id, created: true })
  } catch (err) {
    console.error('[webhook/nuvemshop/order] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
