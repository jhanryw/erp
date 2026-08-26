export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildProductSearchItem, type ProductSearchRow, type ProductSearchItem } from './buildProductSearchItem'
import type { SaleType } from '@/lib/pricing/resolveSalePrice'

export type { ProductSearchItem } from './buildProductSearchItem'

const VALID_SALE_TYPES: SaleType[] = ['retail', 'wholesale']

export async function GET(request: NextRequest) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const companyId = user.company_id
  if (!companyId) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ items: [] })
  }

  // PDV atacado/varejo (2026-09-02) — modalidade explícita, nunca inferida.
  // Ausente = 'retail' (retrocompatível com qualquer chamador que ainda não
  // envie o parâmetro — ex. troca, até este ponto do rollout). Qualquer
  // valor que não seja retail/wholesale é rejeitado, nunca ignorado
  // silenciosamente (mesma postura de "backend nunca confia só no
  // TypeScript do navegador" já aplicada em rpc_create_sale).
  const saleTypeParam = request.nextUrl.searchParams.get('sale_type')
  const saleType: SaleType = saleTypeParam ? (saleTypeParam as SaleType) : 'retail'
  if (!VALID_SALE_TYPES.includes(saleType)) {
    return NextResponse.json({ error: `sale_type inválido: "${saleTypeParam}". Aceitos: retail, wholesale.` }, { status: 400 })
  }

  const admin = createAdminClient()

  // Parallel: get main store ID + product IDs matching name
  const [mainStoreRes, productIdsRes] = await Promise.all([
    admin
      .from('stock_locations')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_main_store', true)
      .single() as unknown as Promise<{ data: { id: number } | null; error: unknown }>,
    admin
      .from('products')
      .select('id')
      .eq('company_id', companyId)
      .eq('active', true)
      .ilike('name', `%${q}%`)
      .limit(12) as unknown as Promise<{ data: Array<{ id: number }> | null; error: unknown }>,
  ])

  if (!mainStoreRes.data) {
    return NextResponse.json({ error: 'Estoque loja não configurado.' }, { status: 500 })
  }

  const mainStoreId = mainStoreRes.data.id
  const productIds = (productIdsRes.data ?? []).map((p) => p.id)

  // Build OR filter: match SKU or product name (via IDs from first query)
  const orFilter =
    productIds.length > 0
      ? `sku_variation.ilike.%${q}%,product_id.in.(${productIds.join(',')})`
      : `sku_variation.ilike.%${q}%`

  type RawVariation = {
    id: number
    sku_variation: string
    price_override: number | null
    cost_override: number | null
    wholesale_price_override: number | null
    stock_balances: Array<{ quantity: number; stock_location_id: number }>
    products: { id: number; name: string; base_price: number; base_cost: number; wholesale_price: number | null } | null
    product_variation_attributes: Array<{
      variation_types: { slug: string } | null
      variation_values: { value: string } | null
    }>
  }

  const { data: rows, error } = (await admin
    .from('product_variations')
    .select(`
      id,
      sku_variation,
      price_override,
      cost_override,
      wholesale_price_override,
      stock_balances!inner (quantity, stock_location_id),
      products!inner (id, name, base_price, base_cost, wholesale_price),
      product_variation_attributes (
        variation_types:variation_type_id (slug),
        variation_values:variation_value_id (value)
      )
    `)
    .eq('active', true)
    .eq('products.active', true)
    .eq('stock_balances.stock_location_id', mainStoreId)
    .gt('stock_balances.quantity', 0)
    .or(orFilter)
    .limit(12)) as unknown as { data: RawVariation[] | null; error: { message: string } | null }

  if (error) {
    console.error('[api/produtos/buscar] query error', error)
    return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })
  }

  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  // Vendas/PDV não está bloqueado, e gerente/admin já viam custo aqui —
  // custo passa a ser exibido para usuario também. Isso NÃO reabre a
  // vulnerabilidade original da Fase 1: a validação de "venda abaixo do
  // custo" e o CMV gravado em sale_items nunca dependeram do que este
  // endpoint retorna nem do que o cliente envia de volta — o servidor
  // sempre recalcula o custo real em resolveAuthoritativeItemCosts()
  // (src/services/vendas.service.ts) antes de validar/gravar qualquer
  // venda, para qualquer role. Este endpoint só decide o que a tela mostra.

  const items: ProductSearchItem[] = (rows ?? []).map((v) => {
    const attrs = v.product_variation_attributes ?? []
    const cor = attrs.find((a) => a.variation_types?.slug === 'cor')?.variation_values?.value ?? null
    const tamanho = attrs.find((a) => a.variation_types?.slug === 'tamanho')?.variation_values?.value ?? null

    // Sum only the main-store balance (already filtered by stock_location_id = mainStoreId)
    const stock = v.stock_balances.reduce((sum, b) => sum + (b.quantity ?? 0), 0)

    // PDV atacado/varejo (2026-09-02) — resolução de preço 100% centralizada
    // em buildProductSearchItem/resolveSalePrice. Este handler nunca decide
    // preço sozinho, só monta a linha bruta do banco.
    const row: ProductSearchRow = {
      variation_id: v.id,
      sku_variation: v.sku_variation,
      product_name: v.products?.name ?? `Variação #${v.id}`,
      base_price: v.products?.base_price ?? 0,
      price_override: v.price_override,
      wholesale_price: v.products?.wholesale_price ?? null,
      wholesale_price_override: v.wholesale_price_override,
      cost: v.cost_override ?? v.products?.base_cost ?? 0,
      cor,
      tamanho,
      stock,
    }

    return buildProductSearchItem(row, saleType)
  })

  return NextResponse.json({ items })
}
