export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  name: z.string().min(2),
  sku: z.string().min(2).max(50),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0),
  base_price: z.coerce.number().positive(),
  active: z.boolean().default(true),
})

type VariationRow = {
  id: number
}

function parseId(id: string) {
  const productId = Number(id)
  return Number.isFinite(productId) ? productId : null
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const productId = parseId(params.id)

  if (!productId) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data, error } = await admin
    .from('products')
    .select('*')
    .eq('id', productId)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Produto não encontrado' }, { status: 404 })
  }

  return NextResponse.json({ product: data })
}

export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const productId = parseId(params.id)

  if (!productId) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  const { error } = await admin
    .from('products')
    .update({
      name: parsed.data.name,
      sku: parsed.data.sku,
      category_id: parsed.data.category_id,
      supplier_id: parsed.data.supplier_id ?? null,
      origin: parsed.data.origin,
      base_cost: parsed.data.base_cost,
      base_price: parsed.data.base_price,
      active: parsed.data.active,
    } as any)
    .eq('id', productId)

  if (error) {
    const msg =
      error.code === '23505'
        ? 'SKU já cadastrado para outro produto.'
        : error.code === '23503'
        ? 'Categoria ou fornecedor inválido.'
        : error.message

    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: productId })
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const productId = parseId(params.id)

  if (!productId) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const admin = createAdminClient()

  // 1. Buscar IDs das variações
  const { data: variations, error: varFetchError } = await admin
    .from('product_variations')
    .select('id')
    .eq('product_id', productId)

  if (varFetchError) {
    return NextResponse.json({ error: varFetchError.message }, { status: 500 })
  }

  const variationIds = ((variations ?? []) as VariationRow[]).map((v) => v.id)

  if (variationIds.length > 0) {
    // 2. Bloquear exclusão se houver itens de venda vinculados
    const { count: saleItemsCount, error: saleCheckError } = await admin
      .from('sale_items')
      .select('id', { count: 'exact', head: true })
      .in('product_variation_id', variationIds)

    if (saleCheckError) {
      return NextResponse.json({ error: saleCheckError.message }, { status: 500 })
    }

    if (saleItemsCount && saleItemsCount > 0) {
      return NextResponse.json(
        { error: 'Produto não pode ser excluído pois possui vendas registradas.' },
        { status: 409 }
      )
    }

    // 3. Excluir atributos das variações (sem cascade no banco)
    const { error: attrError } = await admin
      .from('product_variation_attributes')
      .delete()
      .in('product_variation_id', variationIds)

    if (attrError) {
      return NextResponse.json({ error: attrError.message }, { status: 500 })
    }

    // 4. Excluir lotes de estoque (sem cascade no banco — causa mais comum do FK error)
    const { error: lotsError } = await admin
      .from('stock_lots')
      .delete()
      .in('product_variation_id', variationIds)

    if (lotsError) {
      return NextResponse.json({ error: lotsError.message }, { status: 500 })
    }

    // 5. Excluir posição de estoque atual
    const { error: stockError } = await admin
      .from('stock')
      .delete()
      .in('product_variation_id', variationIds)

    if (stockError) {
      return NextResponse.json({ error: stockError.message }, { status: 500 })
    }

    // 6. Excluir variações
    const { error: variationsError } = await admin
      .from('product_variations')
      .delete()
      .eq('product_id', productId)

    if (variationsError) {
      return NextResponse.json({ error: variationsError.message }, { status: 500 })
    }
  }

  // 7. Excluir produto
  const { error: productError } = await admin
    .from('products')
    .delete()
    .eq('id', productId)

  if (productError) {
    return NextResponse.json({ error: productError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}