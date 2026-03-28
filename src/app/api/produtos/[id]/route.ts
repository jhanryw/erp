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

  const { data: updated, error } = await admin
    .from('products')
    .update({
      ...parsed.data,
      supplier_id: parsed.data.supplier_id ?? null,
    })
    .eq('id', productId)
    .select('id')
    .maybeSingle()

  if (error) {
    const msg =
      error.code === '23505'
        ? 'SKU já cadastrado.'
        : error.code === '23503'
        ? 'Categoria ou fornecedor inválido.'
        : error.message

    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!updated) {
    return NextResponse.json({ error: 'Produto não encontrado' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, id: updated.id })
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

  const { data: variations, error: variationsError } = await admin
    .from('product_variations')
    .select('id')
    .eq('product_id', productId)

  if (variationsError) {
    return NextResponse.json(
      { error: `Erro ao buscar variações: ${variationsError.message}` },
      { status: 500 }
    )
  }

  const variationIds = (variations ?? []).map((v) => v.id)

  if (variationIds.length > 0) {
    const { error: attrError } = await admin
      .from('product_variation_attributes')
      .delete()
      .in('product_variation_id', variationIds)

    if (attrError) {
      return NextResponse.json(
        { error: `Erro ao excluir atributos das variações: ${attrError.message}` },
        { status: 500 }
      )
    }

    const { error: stockError } = await admin
      .from('stock')
      .delete()
      .in('product_variation_id', variationIds)

    if (stockError) {
      return NextResponse.json(
        { error: `Erro ao excluir estoque das variações: ${stockError.message}` },
        { status: 500 }
      )
    }

    const { error: variationDeleteError } = await admin
      .from('product_variations')
      .delete()
      .eq('product_id', productId)

    if (variationDeleteError) {
      const msg =
        variationDeleteError.code === '23503'
          ? 'Existem vendas, entradas ou outros registros vinculados a este produto.'
          : variationDeleteError.message

      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  const { error: productDeleteError } = await admin
    .from('products')
    .delete()
    .eq('id', productId)

  if (productDeleteError) {
    const msg =
      productDeleteError.code === '23503'
        ? 'Este produto possui vínculos e não pode ser excluído diretamente.'
        : productDeleteError.message

    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}