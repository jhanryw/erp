import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { cancelSale } from '@/services/vendas.service'

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'erp-nuvemshop-integration (no-reply@local)'

// ─── HMAC ────────────────────────────────────────────────────────────────────

function verifyNuvemshopHmac(rawBody: string, receivedHmac: string, secret: string): boolean {
  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
  )
  const received = Buffer.from(receivedHmac)

  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

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

function mapPaymentMethod(nsMethod?: string): 'pix' | 'card' | 'cash' {
  if (!nsMethod) return 'pix'
  const m = nsMethod.toLowerCase()
  if (m.includes('pix'))                                           return 'pix'
  if (m.includes('credit') || m.includes('debit') || m.includes('card')) return 'card'
  return 'cash'
}

/**
 * Encontra cliente por email ou CPF. Cria um novo se não encontrar.
 * Requer company_id (multi-tenant) e trata campos opcionais do e-commerce.
 */
async function findOrCreateCustomer(
  admin:      ReturnType<typeof createAdminClient>,
  customer:   NuvemshopCustomer,
  companyId:  number
): Promise<number | null> {
  const email = customer.email?.trim() || null
  const cpf   = customer.identification?.replace(/\D/g, '') || null
  const name  = customer.name?.trim() || 'Cliente Nuvemshop'
  const phone = customer.phone?.trim() || null

  // Buscar por email dentro da mesma empresa
  if (email) {
    const { data } = await (admin as any)
      .from('customers')
      .select('id')
      .eq('email', email)
      .eq('company_id', companyId)
      .maybeSingle() as { data: { id: number } | null }
    if (data) return data.id
  }

  // Buscar por CPF dentro da mesma empresa
  if (cpf) {
    const { data } = await (admin as any)
      .from('customers')
      .select('id')
      .eq('cpf', cpf)
      .eq('company_id', companyId)
      .maybeSingle() as { data: { id: number } | null }
    if (data) return data.id
  }

  // Criar novo cliente — cpf e phone são nullable após migration 20260521
  const { data: created, error } = await (admin as any)
    .from('customers')
    .insert({
      name,
      email:      email ?? null,
      cpf:        cpf   ?? null,
      phone:      phone ?? null,
      origin:     'website',
      company_id: companyId,
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
  // ── HMAC: ler body bruto antes de qualquer parse ────────────────────────────
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Erro ao ler body.' }, { status: 400 })
  }

  const clientSecret = process.env.NUVEMSHOP_CLIENT_SECRET
  const skipHmac     =
    process.env.NODE_ENV !== 'production' &&
    process.env.NUVEMSHOP_SKIP_WEBHOOK_HMAC === 'true'

  if (skipHmac) {
    console.warn(
      '[webhook/order] ATENÇÃO: validação HMAC desabilitada via NUVEMSHOP_SKIP_WEBHOOK_HMAC=true. ' +
      'NUNCA use isso em produção.'
    )
  } else if (!clientSecret) {
    console.error('[webhook/order] NUVEMSHOP_CLIENT_SECRET não configurado. Rejeitar request.')
    return NextResponse.json({ error: 'Configuração inválida do servidor.' }, { status: 500 })
  } else {
    const receivedHmac = request.headers.get('x-linkedstore-hmac-sha256') ?? ''
    if (!receivedHmac) {
      return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 })
    }
    if (!verifyNuvemshopHmac(rawBody, receivedHmac, clientSecret)) {
      return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 })
    }
  }

  // ── Parse do body já validado ───────────────────────────────────────────────
  let body: { store_id?: number; event?: string; id?: number }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const { id: orderId, event } = body

  if (!orderId || !event) {
    return NextResponse.json({ error: 'id e event obrigatórios.' }, { status: 400 })
  }

  try {
    const storeId      = process.env.NUVEMSHOP_STORE_ID
    const token        = process.env.NUVEMSHOP_ACCESS_TOKEN
    const systemUserId = process.env.NUVEMSHOP_SYSTEM_USER_ID ?? ''

    // ── 1. Buscar pedido completo na Nuvemshop ──────────────────────────────────
    const apiRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
      { headers: { Authentication: `bearer ${token}`, 'User-Agent': APP_AGENT } }
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

    // ── 2. Buscar company_id do usuário sistema (necessário para clientes) ──────
    const { data: systemUser } = await (admin as any)
      .from('users')
      .select('company_id')
      .eq('id', systemUserId)
      .maybeSingle() as { data: { company_id: number } | null }

    const companyId = systemUser?.company_id ?? null
    if (!companyId) {
      console.error('[webhook/order] NUVEMSHOP_SYSTEM_USER_ID sem company_id', { systemUserId })
      return NextResponse.json({ error: 'Configuração inválida: system user sem empresa.' }, { status: 500 })
    }

    // ── 3. Liberar locks zumbis antes de qualquer verificação ───────────────────
    await (admin as any).rpc('release_stale_pedido_locks').catch(() => null)

    // ── 4. Verificar / criar staging do pedido ──────────────────────────────────
    const { data: existing } = (await (admin as any)
      .from('pedidos')
      .select('id, stock_processed, sale_id, processing_lock')
      .eq('external_id', externalId)
      .eq('source', 'nuvemshop')
      .maybeSingle()) as {
        data: {
          id: number
          stock_processed: boolean
          sale_id: number | null
          processing_lock: boolean
        } | null
      }

    let pedidoId: number

    if (existing) {
      pedidoId = existing.id
      await (admin as any)
        .from('pedidos')
        .update({
          status: channelStatus, channel_status: channelStatus,
          total, customer_name: customerName, customer_email: customerEmail,
        })
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
          processing_lock: false,
        })
        .select('id')
        .single()) as { data: { id: number } | null; error: { message: string } | null }

      if (pedidoError || !pedido) {
        console.error('[webhook/order] Erro ao inserir pedido', pedidoError?.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }
      pedidoId = pedido.id
    }

    // ── 5. Cancelamento ─────────────────────────────────────────────────────────
    if (
      event === 'orders/cancelled' ||
      event === 'order/cancelled'  ||
      channelStatus === 'cancelled'
    ) {
      const saleId = existing?.sale_id ?? null

      if (saleId) {
        const cancelResult = await cancelSale(saleId, systemUserId, null)
        if (!cancelResult.ok) {
          console.error('[webhook/order] Erro ao cancelar venda', cancelResult.error)
        } else {
          const { data: itens } = (await (admin as any)
            .from('pedidos_itens')
            .select('product_variation_id')
            .eq('pedido_id', pedidoId)
            .eq('mapped', true)) as { data: Array<{ product_variation_id: number }> | null }

          for (const item of itens ?? []) {
            await pushVariantStockToNuvemshop(item.product_variation_id, {
              eventType: 'stock_confirm_ns', externalOrderId: externalId,
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

    // ── 6. Pedido pago: verificação de status ───────────────────────────────────
    if (channelStatus !== 'paid') {
      return NextResponse.json({ ok: true, skipped: true })
    }

    // Já foi processado com sucesso anteriormente
    if (existing?.stock_processed && existing?.sale_id) {
      return NextResponse.json({ ok: true, already_processed: true })
    }

    // ── 7. LOCK ATÔMICO — previne processamento duplicado ───────────────────────
    // UPDATE ... WHERE processing_lock = false RETURNING id é atômico no PG.
    // Se dois webhooks chegam simultaneamente, apenas um recebe a linha de volta.
    const { data: claimed } = await (admin as any)
      .from('pedidos')
      .update({
        processing_lock:       true,
        processing_claimed_at: new Date().toISOString(),
      })
      .eq('id', pedidoId)
      .eq('stock_processed', false)
      .eq('processing_lock', false)
      .select('id')
      .maybeSingle() as { data: { id: number } | null }

    if (!claimed) {
      // Outro processo já está tratando este pedido
      return NextResponse.json({ ok: true, already_processing: true })
    }

    if (order.products.length === 0) {
      await (admin as any)
        .from('pedidos')
        .update({ processing_lock: false, processing_claimed_at: null })
        .eq('id', pedidoId)
      return NextResponse.json({ ok: true, imported: true })
    }

    // ── 8. Buscar mapeamentos de variantes ──────────────────────────────────────
    const externalVariantIds = order.products
      .map((p) => p.variant_id)
      .filter((v): v is number => v != null)
      .map(String)

    type MappingRow = { external_variant_id: string; product_variation_id: number }
    let variantMappings: MappingRow[] = []

    if (externalVariantIds.length > 0) {
      const { data: mappings } = (await (admin as any)
        .from('produto_map')
        .select('external_variant_id, product_variation_id')
        .eq('source', 'nuvemshop')
        .in('external_variant_id', externalVariantIds)) as { data: MappingRow[] | null }
      variantMappings = mappings ?? []
    }

    const mappingByVariantId = new Map<string, MappingRow>()
    for (const m of variantMappings) mappingByVariantId.set(m.external_variant_id, m)

    // ── 9. Inserir / recriar itens do pedido ────────────────────────────────────
    await (admin as any).from('pedidos_itens').delete().eq('pedido_id', pedidoId)

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
        data: Array<{
          id: number
          product_variation_id: number | null
          mapped: boolean
          quantidade: number
          preco: number
        }> | null
        error: { message: string } | null
      }

    if (itensError || !insertedItens) {
      console.error('[webhook/order] Erro ao inserir itens', itensError?.message)
      await (admin as any)
        .from('pedidos')
        .update({ processing_lock: false, processing_claimed_at: null })
        .eq('id', pedidoId)
      return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
    }

    const mappedItens = insertedItens.filter((i) => i.mapped && i.product_variation_id != null)

    if (mappedItens.length === 0) {
      console.warn('[webhook/order] Nenhum item mapeado — venda não criada no ERP', { externalId })
      await (admin as any)
        .from('pedidos')
        .update({ processing_lock: false, processing_claimed_at: null })
        .eq('id', pedidoId)
      return NextResponse.json({ ok: true, imported: true, mapped_items: 0 })
    }

    // ── 10. Buscar custo médio de cada variação ─────────────────────────────────
    const variationIds = mappedItens.map((i) => i.product_variation_id!)

    const { data: stockRows } = (await admin
      .from('stock')
      .select('product_variation_id, avg_cost')
      .in('product_variation_id', variationIds)) as unknown as {
        data: Array<{ product_variation_id: number; avg_cost: number }> | null
      }

    const avgCostByVariation = new Map<number, number>()
    for (const s of stockRows ?? []) avgCostByVariation.set(s.product_variation_id, s.avg_cost ?? 0)

    // ── 11. Encontrar ou criar cliente ──────────────────────────────────────────
    const customerId = await findOrCreateCustomer(admin, order.customer ?? {}, companyId)

    if (!customerId) {
      console.error('[webhook/order] Não foi possível encontrar/criar cliente', { externalId })
      await (admin as any)
        .from('pedidos')
        .update({ processing_lock: false, processing_claimed_at: null })
        .eq('id', pedidoId)
      return NextResponse.json({ error: 'Erro ao processar cliente.' }, { status: 500 })
    }

    // ── 12. Montar itens para rpc_create_sale ───────────────────────────────────
    const saleItems = mappedItens.map((i) => ({
      product_variation_id: i.product_variation_id!,
      quantity:             i.quantidade,
      unit_price:           i.preco,
      unit_cost:            avgCostByVariation.get(i.product_variation_id!) ?? 0,
      discount_amount:      0,
    }))

    const shippingCharged = parseFloat(order.total_shipping ?? '0')
    const paymentMethod   = mapPaymentMethod(order.payment_details?.method)

    // ── 13. Criar venda completa no ERP (atômico via RPC) ───────────────────────
    const { data: sale, error: saleError } = await (admin as any)
      .rpc('rpc_create_sale', {
        p_customer_id:         customerId,
        p_seller_id:           systemUserId,
        p_payment_method:      paymentMethod,
        p_sale_origin:         'website',
        p_discount_amount:     0,
        p_surcharge_amount:    0,
        p_cashback_used:       0,
        p_shipping_charged:    shippingCharged,
        p_notes:               `Pedido Nuvemshop #${externalId}`,
        p_items:               saleItems,
        p_system_user_id:      systemUserId,
        p_stock_mode:          'online_priority',
      }) as unknown as { data: { id: number; sale_number: string } | null; error: { message: string } | null }

    if (saleError || !sale) {
      console.error('[webhook/order] Erro ao criar venda', saleError?.message, { externalId })
      await (admin as any)
        .from('pedidos')
        .update({ processing_lock: false, processing_claimed_at: null })
        .eq('id', pedidoId)
      return NextResponse.json({ error: 'Erro ao criar venda no ERP.' }, { status: 500 })
    }

    // ── 14. Registrar movimentações de estoque por canal ────────────────────────
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

    // ── 15. Confirmar estoque final na Nuvemshop ─────────────────────────────────
    for (const item of mappedItens) {
      await pushVariantStockToNuvemshop(item.product_variation_id!, {
        eventType:       'stock_confirm_ns',
        externalOrderId: externalId,
      })
    }

    // ── 16. Marcar pedido como processado e liberar lock ─────────────────────────
    await (admin as any)
      .from('pedidos')
      .update({
        stock_processed:       true,
        sale_id:               sale.id,
        customer_id:           customerId,
        operational_status:    'pronto',
        processing_lock:       false,
        processing_claimed_at: null,
      })
      .eq('id', pedidoId)

    return NextResponse.json({
      ok:          true,
      imported:    true,
      sale_id:     sale.id,
      sale_number: sale.sale_number,
    })
  } catch (err) {
    console.error('[webhook/order] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
