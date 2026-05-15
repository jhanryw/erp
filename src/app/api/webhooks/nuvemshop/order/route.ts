import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { cancelSale } from '@/services/vendas.service'

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'erp-nuvemshop-integration (no-reply@local)'

// ─── Env vars necessárias ─────────────────────────────────────────────────────
// NUVEMSHOP_STORE_ID         — ID numérico da loja
// NUVEMSHOP_ACCESS_TOKEN     — token de acesso
// NUVEMSHOP_SYSTEM_USER_ID   — UUID do usuário sistema usado como p_seller_id no rpc_create_sale

// ─── Tipos do payload da Nuvemshop ────────────────────────────────────────────

type NuvemshopCustomer = {
  name?:           string
  email?:          string
  phone?:          string
  identification?: string
}

type NuvemshopOrderItem = {
  id:         number
  product_id: number
  variant_id: number | null
  sku:        string | null
  name:       string | Record<string, string>
  quantity:   number
  price:      string
}

type NuvemshopOrder = {
  id:               number
  status:           string
  total:            string
  total_shipping?:  string
  customer:         NuvemshopCustomer | null
  products:         NuvemshopOrderItem[]
  payment_details?: { method?: string } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveName(name: string | Record<string, string>): string {
  if (typeof name === 'string') return name
  return name.pt ?? name.es ?? name.en ?? Object.values(name)[0] ?? ''
}

/** Mapeia método de pagamento Nuvemshop → ERP. */
function mapPaymentMethod(nsMethod?: string): 'pix' | 'card' | 'cash' {
  if (!nsMethod) return 'pix'
  const m = nsMethod.toLowerCase()
  if (m.includes('pix'))                    return 'pix'
  if (m.includes('credit') || m.includes('debit') || m.includes('card')) return 'card'
  return 'cash'
}

/** Encontra cliente por e-mail ou CPF. Cria um novo se não encontrar. */
async function findOrCreateCustomer(
  admin:    ReturnType<typeof createAdminClient>,
  customer: NuvemshopCustomer
): Promise<number | null> {
  const email = customer.email?.trim() || null
  const cpf   = customer.identification?.replace(/\D/g, '') || null
  const name  = customer.name?.trim() || 'Cliente Nuvemshop'

  // Tentar encontrar por e-mail primeiro, depois por CPF
  if (email) {
    const { data } = await (admin as any)
      .from('customers')
      .select('id')
      .eq('email', email)
      .maybeSingle() as { data: { id: number } | null }
    if (data) return data.id
  }

  if (cpf) {
    const { data } = await (admin as any)
      .from('customers')
      .select('id')
      .eq('cpf', cpf)
      .maybeSingle() as { data: { id: number } | null }
    if (data) return data.id
  }

  // Criar novo cliente
  const { data: created, error } = await (admin as any)
    .from('customers')
    .insert({
      name,
      email:  email ?? null,
      cpf:    cpf   ?? null,
      phone:  customer.phone?.trim() ?? null,
      origin: 'website',
    })
    .select('id')
    .single() as { data: { id: number } | null; error: { message: string } | null }

  if (error || !created) {
    console.error('[webhook/order] Erro ao criar cliente', error?.message)
    return null
  }

  return created.id
}

// ─── Rota ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: { store_id?: number; event?: string; id?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const { id: orderId, event } = body

  if (!orderId || !event) {
    return NextResponse.json({ error: 'id e event obrigatórios.' }, { status: 400 })
  }

  try {
    const storeId = process.env.NUVEMSHOP_STORE_ID
    const token   = process.env.NUVEMSHOP_ACCESS_TOKEN

    // ── 1. Buscar pedido completo na Nuvemshop ──────────────────────────────────
    const apiRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
      {
        headers: {
          Authentication: `bearer ${token}`,
          'User-Agent':   APP_AGENT,
        },
      }
    )

    if (!apiRes.ok) {
      const text = await apiRes.text()
      console.error('[webhook/order] Erro ao buscar pedido na Nuvemshop', apiRes.status, text)
      return NextResponse.json({ error: 'Erro ao buscar pedido.' }, { status: 502 })
    }

    const order = await apiRes.json() as NuvemshopOrder

    const externalId    = String(order.id)
    const channelStatus = order.status ?? ''
    const total         = parseFloat(order.total ?? '0')
    const customerName  = order.customer?.name  ?? ''
    const customerEmail = order.customer?.email ?? ''

    const admin = createAdminClient()

    // ── 2. Verificar / criar staging do pedido ──────────────────────────────────
    const { data: existing } = (await (admin as any)
      .from('pedidos')
      .select('id, stock_processed, sale_id')
      .eq('external_id', externalId)
      .eq('source', 'nuvemshop')
      .maybeSingle()) as { data: { id: number; stock_processed: boolean; sale_id: number | null } | null }

    let pedidoId: number

    if (existing) {
      pedidoId = existing.id
      await (admin as any)
        .from('pedidos')
        .update({ status: channelStatus, channel_status: channelStatus, total, customer_name: customerName, customer_email: customerEmail })
        .eq('id', pedidoId)
    } else {
      const { data: pedido, error: pedidoError } = (await (admin as any)
        .from('pedidos')
        .insert({
          external_id:     externalId,
          source:          'nuvemshop',
          status:          channelStatus,
          channel_status:  channelStatus,
          total,
          customer_name:   customerName,
          customer_email:  customerEmail,
          stock_processed: false,
        })
        .select('id')
        .single()) as { data: { id: number } | null; error: { message: string } | null }

      if (pedidoError || !pedido) {
        console.error('[webhook/order] Erro ao inserir pedido', pedidoError?.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }
      pedidoId = pedido.id
    }

    // ── 3. Cancelamento ─────────────────────────────────────────────────────────
    if (event === 'orders/cancelled' || event === 'order/cancelled' || channelStatus === 'cancelled') {
      const saleId = existing?.sale_id ?? null

      if (saleId) {
        const systemUserId = process.env.NUVEMSHOP_SYSTEM_USER_ID ?? ''
        const cancelResult = await cancelSale(saleId, systemUserId, null)

        if (!cancelResult.ok) {
          console.error('[webhook/order] Erro ao cancelar venda', cancelResult.error)
          // Não falha o webhook — pode já estar cancelada
        } else {
          // Buscar itens do pedido para confirmar estoque na Nuvemshop
          const { data: itens } = (await (admin as any)
            .from('pedidos_itens')
            .select('product_variation_id')
            .eq('pedido_id', pedidoId)
            .eq('mapped', true)) as { data: Array<{ product_variation_id: number }> | null }

          for (const item of itens ?? []) {
            await pushVariantStockToNuvemshop(item.product_variation_id, {
              eventType:       'stock_confirm_ns',
              externalOrderId: externalId,
            })
          }
        }
      }

      await (admin as any)
        .from('pedidos')
        .update({ status: 'cancelled', channel_status: 'cancelled' })
        .eq('id', pedidoId)

      return NextResponse.json({ ok: true, cancelled: true })
    }

    // ── 4. Pedido pago: já processado? ──────────────────────────────────────────
    if (channelStatus !== 'paid') {
      return NextResponse.json({ ok: true, skipped: true })
    }

    if (existing?.stock_processed && existing?.sale_id) {
      return NextResponse.json({ ok: true, already_processed: true })
    }

    if (order.products.length === 0) {
      return NextResponse.json({ ok: true, imported: true })
    }

    // ── 5. Buscar mapeamentos de variantes ──────────────────────────────────────
    const externalVariantIds = order.products
      .map((p) => p.variant_id)
      .filter((v): v is number => v != null)
      .map(String)

    type MappingRow = { external_variant_id: string; product_variation_id: number; external_id: string }
    let variantMappings: MappingRow[] = []

    if (externalVariantIds.length > 0) {
      const { data: mappings } = (await (admin as any)
        .from('produto_map')
        .select('external_variant_id, product_variation_id, external_id')
        .eq('source', 'nuvemshop')
        .in('external_variant_id', externalVariantIds)) as { data: MappingRow[] | null }
      variantMappings = mappings ?? []
    }

    const mappingByVariantId = new Map<string, MappingRow>()
    for (const m of variantMappings) mappingByVariantId.set(m.external_variant_id, m)

    // ── 6. Inserir / recriar itens do pedido ────────────────────────────────────
    if (order.products.length > 0) {
      await (admin as any).from('pedidos_itens').delete().eq('pedido_id', pedidoId)
    }

    const itensPayload = order.products.map((p) => {
      const variantKey = p.variant_id != null ? String(p.variant_id) : null
      const mapping    = variantKey ? mappingByVariantId.get(variantKey) : undefined
      return {
        pedido_id:            pedidoId,
        external_product_id:  String(p.product_id ?? p.id),
        nome:                 resolveName(p.name),
        quantidade:           Number(p.quantity),
        preco:                parseFloat(p.price ?? '0'),
        product_variation_id: mapping?.product_variation_id ?? null,
        mapped:               mapping != null,
      }
    })

    const { data: insertedItens, error: itensError } = (await (admin as any)
      .from('pedidos_itens')
      .insert(itensPayload)
      .select('id, product_variation_id, mapped, quantidade, preco')) as {
        data: Array<{ id: number; product_variation_id: number | null; mapped: boolean; quantidade: number; preco: number }> | null
        error: { message: string } | null
      }

    if (itensError || !insertedItens) {
      console.error('[webhook/order] Erro ao inserir itens', itensError?.message)
      return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
    }

    const mappedItens = insertedItens.filter((i) => i.mapped && i.product_variation_id != null)

    if (mappedItens.length === 0) {
      console.warn('[webhook/order] Nenhum item mapeado — venda não criada no ERP', { externalId })
      return NextResponse.json({ ok: true, imported: true, mapped_items: 0 })
    }

    // ── 7. Buscar custo médio de cada variação ──────────────────────────────────
    const variationIds = mappedItens.map((i) => i.product_variation_id!)

    const { data: stockRows } = (await admin
      .from('stock')
      .select('product_variation_id, avg_cost')
      .in('product_variation_id', variationIds)) as unknown as {
        data: Array<{ product_variation_id: number; avg_cost: number }> | null
      }

    const avgCostByVariation = new Map<number, number>()
    for (const s of stockRows ?? []) avgCostByVariation.set(s.product_variation_id, s.avg_cost ?? 0)

    // ── 8. Encontrar ou criar cliente ───────────────────────────────────────────
    const customerId = await findOrCreateCustomer(admin, order.customer ?? {})

    if (!customerId) {
      console.error('[webhook/order] Não foi possível encontrar/criar cliente', { externalId })
      return NextResponse.json({ error: 'Erro ao processar cliente.' }, { status: 500 })
    }

    // ── 9. Montar itens para rpc_create_sale ────────────────────────────────────
    const saleItems = mappedItens.map((i) => ({
      product_variation_id: i.product_variation_id!,
      quantity:             i.quantidade,
      unit_price:           i.preco,
      unit_cost:            avgCostByVariation.get(i.product_variation_id!) ?? 0,
      discount_amount:      0,
    }))

    const shippingCharged  = parseFloat(order.total_shipping ?? '0')
    const paymentMethod    = mapPaymentMethod(order.payment_details?.method)
    const systemUserId     = process.env.NUVEMSHOP_SYSTEM_USER_ID ?? ''

    // ── 10. Criar venda completa no ERP (atômico via RPC) ───────────────────────
    const { data: sale, error: saleError } = await (admin as any)
      .rpc('rpc_create_sale', {
        p_customer_id:         customerId,
        p_seller_id:           systemUserId,
        p_payment_method:      paymentMethod,
        p_sale_origin:         'nuvemshop',
        p_discount_amount:     0,
        p_surcharge_amount:    0,
        p_cashback_used:       0,
        p_shipping_charged:    shippingCharged,
        p_notes:               `Pedido Nuvemshop #${externalId}`,
        p_items:               saleItems,
        p_system_user_id:      systemUserId,
        p_accumulate_cashback: true,
      }) as unknown as { data: { id: number; sale_number: string } | null; error: { message: string } | null }

    if (saleError || !sale) {
      console.error('[webhook/order] Erro ao criar venda', saleError?.message, { externalId })
      return NextResponse.json({ error: 'Erro ao criar venda no ERP.' }, { status: 500 })
    }

    // ── 11. Registrar movimentações de estoque por canal ────────────────────────
    for (const item of mappedItens) {
      await (admin as any)
        .from('estoque_movimentacoes')
        .insert({
          product_variation_id: item.product_variation_id,
          tipo:                 'saida',
          origem:               'nuvemshop',
          referencia_externa:   externalId,
          quantidade:           item.quantidade,
        })
        .catch((err: unknown) =>
          console.error('[webhook/order] Erro ao registrar estoque_movimentacoes', err)
        )
    }

    // ── 12. Confirmar estoque final na Nuvemshop ─────────────────────────────────
    for (const item of mappedItens) {
      await pushVariantStockToNuvemshop(item.product_variation_id!, {
        eventType:       'stock_confirm_ns',
        externalOrderId: externalId,
      })
    }

    // ── 13. Marcar pedido como processado ────────────────────────────────────────
    await (admin as any)
      .from('pedidos')
      .update({
        stock_processed:    true,
        sale_id:            sale.id,
        customer_id:        customerId,
        operational_status: 'pronto',
      })
      .eq('id', pedidoId)

    return NextResponse.json({ ok: true, imported: true, sale_id: sale.id, sale_number: sale.sale_number })
  } catch (err) {
    console.error('[webhook/order] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
