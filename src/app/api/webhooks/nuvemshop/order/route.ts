import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateVariantStock } from '@/lib/integrations/nuvemshop'

const APP_AGENT =
  process.env.NUVEMSHOP_APP_AGENT ?? 'erp-nuvemshop-integration (no-reply@local)'

// ─── Tipos do payload da Nuvemshop ────────────────────────────────────────────

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
  id:       number
  status:   string
  total:    string
  customer: { name?: string; email?: string } | null
  products: NuvemshopOrderItem[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveName(name: string | Record<string, string>): string {
  if (typeof name === 'string') return name
  return name.pt ?? name.es ?? name.en ?? Object.values(name)[0] ?? ''
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
    // ── 1. Buscar pedido completo na Nuvemshop ──────────────────────────────────
    const storeId = process.env.NUVEMSHOP_STORE_ID
    const token   = process.env.NUVEMSHOP_ACCESS_TOKEN

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

    // ── 2. Mapear campos base ───────────────────────────────────────────────────
    const externalId        = String(order.id)
    const channelStatus     = order.status ?? ''
    const operationalStatus = channelStatus === 'paid' ? 'pronto' : null
    const total             = parseFloat(order.total ?? '0')
    const customerName      = order.customer?.name  ?? ''
    const customerEmail     = order.customer?.email ?? ''

    const admin = createAdminClient()

    // ── 3. Verificar se pedido já existe ────────────────────────────────────────
    const { data: existing } = (await (admin as any)
      .from('pedidos')
      .select('id, stock_processed')
      .eq('external_id', externalId)
      .eq('source', 'nuvemshop')
      .maybeSingle()) as { data: { id: number; stock_processed: boolean } | null }

    let pedidoId: number

    if (existing) {
      pedidoId = existing.id

      // Atualizar status sempre
      const updatePayload: Record<string, unknown> = {
        status:         channelStatus,
        channel_status: channelStatus,
        total,
        customer_name:  customerName,
        customer_email: customerEmail,
      }
      if (operationalStatus) updatePayload.operational_status = operationalStatus

      const { error: updateError } = (await (admin as any)
        .from('pedidos')
        .update(updatePayload)
        .eq('id', pedidoId)) as { error: { message: string } | null }

      if (updateError) {
        console.error('[webhook/order] Erro ao atualizar pedido', updateError.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }

      // Se estoque já processado, não retoca os itens — só atualiza status
      if (existing.stock_processed) {
        return NextResponse.json({ ok: true, imported: true })
      }

      // Estoque ainda não processado: recriar itens para novo processamento
      if (order.products.length > 0) {
        await (admin as any).from('pedidos_itens').delete().eq('pedido_id', pedidoId)
      }
    } else {
      // ── INSERT novo pedido ────────────────────────────────────────────────────
      const { data: pedido, error: pedidoError } = (await (admin as any)
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
          stock_processed:    false,
        })
        .select('id')
        .single()) as { data: { id: number } | null; error: { message: string } | null }

      if (pedidoError || !pedido) {
        console.error('[webhook/order] Erro ao inserir pedido', pedidoError?.message)
        return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
      }

      pedidoId = pedido.id
    }

    // ── 4. Inserir itens com mapeamento de variação ─────────────────────────────
    if (order.products.length === 0) {
      return NextResponse.json({ ok: true, imported: true })
    }

    // Buscar mapeamentos de variantes existentes para os variant_ids deste pedido
    const externalVariantIds = order.products
      .map((p) => p.variant_id)
      .filter((v): v is number => v != null)
      .map(String)

    type MappingRow = {
      external_variant_id: string
      product_variation_id: number
      external_id: string
    }

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
    for (const m of variantMappings) {
      mappingByVariantId.set(m.external_variant_id, m)
    }

    // Construir linhas de itens
    const itens = order.products.map((p) => {
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
      .insert(itens)
      .select('id, product_variation_id, mapped, quantidade')) as {
        data: Array<{ id: number; product_variation_id: number | null; mapped: boolean; quantidade: number }> | null
        error: { message: string } | null
      }

    if (itensError || !insertedItens) {
      console.error('[webhook/order] Erro ao inserir itens', itensError?.message)
      return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
    }

    // ── 5. Baixa de estoque (apenas para pedidos pagos com itens mapeados) ───────
    const shouldDeductStock = channelStatus === 'paid'

    if (shouldDeductStock) {
      for (const item of insertedItens) {
        if (!item.mapped || item.product_variation_id == null) continue

        try {
          // 5a. Baixar estoque no ERP via RPC idempotente
          const { data: rpcResult, error: rpcError } = (await (admin as any).rpc(
            'rpc_nuvemshop_sale_deduct',
            {
              p_product_variation_id: item.product_variation_id,
              p_quantity:             item.quantidade,
              p_external_order_id:    externalId,
            }
          )) as { data: { new_quantity: number; skipped: boolean } | null; error: { message: string } | null }

          if (rpcError) {
            console.error(
              '[webhook/order] rpc_nuvemshop_sale_deduct falhou',
              { item_id: item.id, error: rpcError.message }
            )
            continue
          }

          const newQty   = rpcResult?.new_quantity ?? 0
          const skipped  = rpcResult?.skipped ?? false

          // 5b. Registrar em estoque_movimentacoes (tracking por canal)
          if (!skipped) {
            const { error: movError } = (await (admin as any)
              .from('estoque_movimentacoes')
              .insert({
                product_variation_id: item.product_variation_id,
                tipo:                 'saida',
                origem:               'nuvemshop',
                referencia_externa:   externalId,
                quantidade:           item.quantidade,
              })) as { error: { message: string } | null }

            if (movError) {
              console.error('[webhook/order] Erro ao registrar estoque_movimentacoes', movError.message)
              // Não interrompe o fluxo — ledger principal (stock_movements) já foi atualizado pela RPC
            }

            // 5c. Sincronizar estoque de volta para a Nuvemshop
            // Buscar external_variant_id para chamar updateVariantStock
            const variantKeyForItem = order.products.find(
              (p) => {
                const variantKey = p.variant_id != null ? String(p.variant_id) : null
                const mapping    = variantKey ? mappingByVariantId.get(variantKey) : undefined
                return mapping?.product_variation_id === item.product_variation_id
              }
            )

            if (variantKeyForItem?.variant_id != null) {
              const mapping = mappingByVariantId.get(String(variantKeyForItem.variant_id))
              if (mapping) {
                try {
                  await updateVariantStock(
                    mapping.external_id,
                    String(variantKeyForItem.variant_id),
                    newQty
                  )
                } catch (syncErr) {
                  console.error(
                    '[webhook/order] Erro ao sincronizar estoque na Nuvemshop',
                    { variant_id: variantKeyForItem.variant_id, error: syncErr }
                  )
                  // Falha não crítica: ERP está correto, Nuvemshop será corrigida em próxima sincronização
                }
              }
            }
          }
        } catch (stockErr) {
          console.error('[webhook/order] Exceção na baixa de estoque do item', { item_id: item.id, error: stockErr })
          // Continua para próximo item — não deve falhar o webhook inteiro
        }
      }

      // 5d. Marcar pedido como processado para evitar dupla baixa
      await (admin as any)
        .from('pedidos')
        .update({ stock_processed: true })
        .eq('id', pedidoId)
    }

    return NextResponse.json({ ok: true, imported: true })
  } catch (err) {
    console.error('[webhook/order] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
