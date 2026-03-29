export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { canDeleteProduct, deleteProductCascade, getProductSnapshot, checkPriceChange } from '@/services/produtos.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// ─── Schemas ──────────────────────────────────────────────────────────────────

const variantToAddSchema = z.object({
  sku_variation: z.string().min(1, 'SKU da variação obrigatório'),
  color_value_id: z.number().int().positive().nullable().optional(),
  size_value_id: z.number().int().positive().nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override: z.coerce.number().min(0).nullable().optional(),
})

const putSchema = z.object({
  name: z.string().min(2),
  sku: z.string().min(2).max(50),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0),
  base_price: z.coerce.number().positive(),
  active: z.boolean().default(true),
  variations_to_delete: z.array(z.number().int().positive()).optional(),
  variations_to_add: z.array(variantToAddSchema).optional(),
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseId(id: string) {
  const n = Number(id)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ─── GET /api/produtos/[id] ───────────────────────────────────────────────────
// Retorna produto + variações com atributos para a tela de edição

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const productId = parseId(params.id)
  if (!productId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()

  const { data: product, error: productError } = await admin
    .from('products')
    .select('id, name, sku, category_id, supplier_id, origin, base_cost, base_price, active, photo_url')
    .eq('id', productId)
    .single()

  if (productError || !product) {
    return NextResponse.json({ error: 'Produto não encontrado' }, { status: 404 })
  }

  const { data: variations, error: variationsError } = await admin
    .from('product_variations')
    .select(`
      id,
      sku_variation,
      cost_override,
      price_override,
      active,
      product_variation_attributes (
        variation_type_id,
        variation_value_id,
        variation_types:variation_type_id ( name, slug ),
        variation_values:variation_value_id ( value, slug )
      )
    `)
    .eq('product_id', productId)
    .order('sku_variation')

  if (variationsError) {
    return NextResponse.json({ error: variationsError.message }, { status: 500 })
  }

  return NextResponse.json({ product, variations: variations ?? [] })
}

// ─── PUT /api/produtos/[id] ───────────────────────────────────────────────────
// Atualiza produto base + processa variations_to_delete e variations_to_add

export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const productId = parseId(params.id)
  if (!productId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { variations_to_delete, variations_to_add, ...productFields } = parsed.data

  // Snapshot antes para auditoria
  const before = await getProductSnapshot(productId)

  // Verificar regra de preço (warning, não bloqueio)
  const priceCheck = await checkPriceChange(productId, productFields.base_price, productFields.base_cost)
  const priceWarning = priceCheck.warning

  const admin = createAdminClient() // admin client: escrita multi-tabela produtos+variações

  // ── 1. Atualizar produto base ───────────────────────────────────────────────

  const { error: updateError } = await (admin as any)
    .from('products')
    .update({
      name: productFields.name,
      sku: productFields.sku,
      category_id: productFields.category_id,
      supplier_id: productFields.supplier_id ?? null,
      origin: productFields.origin,
      base_cost: productFields.base_cost,
      base_price: productFields.base_price,
      active: productFields.active,
    })
    .eq('id', productId) as { error: { code: string; message: string } | null }

  if (updateError) {
    const msg =
      updateError.code === '23505' ? 'SKU já cadastrado para outro produto.' :
      updateError.code === '23503' ? 'Categoria ou fornecedor inválido.' :
      updateError.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // ── 2. Remover variações ────────────────────────────────────────────────────

  if (variations_to_delete && variations_to_delete.length > 0) {
    for (const varId of variations_to_delete) {

      // Verificar que a variação pertence a este produto
      const { data: varCheck, error: varCheckError } = await admin
        .from('product_variations')
        .select('id')
        .eq('id', varId)
        .eq('product_id', productId)
        .maybeSingle() as unknown as { data: { id: number } | null; error: any }

      if (varCheckError) return NextResponse.json({ error: varCheckError.message }, { status: 500 })

      if (!varCheck) {
        return NextResponse.json(
          { error: `Variação #${varId} não pertence a este produto.` },
          { status: 400 }
        )
      }

      // Bloquear se tiver itens de venda vinculados
      const { count: saleCount, error: saleCheckError } = await admin
        .from('sale_items')
        .select('id', { count: 'exact', head: true })
        .eq('product_variation_id', varId)

      if (saleCheckError) return NextResponse.json({ error: saleCheckError.message }, { status: 500 })

      if (saleCount && saleCount > 0) {
        return NextResponse.json(
          { error: `Variação #${varId} possui vendas registradas e não pode ser removida.` },
          { status: 409 }
        )
      }

      // Bloquear se tiver lotes de estoque vinculados
      const { count: lotsCount, error: lotsCheckError } = await admin
        .from('stock_lots')
        .select('id', { count: 'exact', head: true })
        .eq('product_variation_id', varId)

      if (lotsCheckError) return NextResponse.json({ error: lotsCheckError.message }, { status: 500 })

      if (lotsCount && lotsCount > 0) {
        return NextResponse.json(
          { error: `Variação #${varId} possui lotes de estoque e não pode ser removida.` },
          { status: 409 }
        )
      }

      // Deletar posição de estoque (sem cascade)
      const { error: stockDelError } = await admin
        .from('stock')
        .delete()
        .eq('product_variation_id', varId)

      if (stockDelError) return NextResponse.json({ error: stockDelError.message }, { status: 500 })

      // Deletar variação — product_variation_attributes tem ON DELETE CASCADE
      const { error: varDelError } = await admin
        .from('product_variations')
        .delete()
        .eq('id', varId)

      if (varDelError) return NextResponse.json({ error: varDelError.message }, { status: 500 })
    }
  }

  // ── 3. Adicionar novas variações ────────────────────────────────────────────
  // Mesma lógica do POST /api/produtos, sem initial_stock (novas variações começam com 0)

  if (variations_to_add && variations_to_add.length > 0) {
    for (const v of variations_to_add) {

      // Inserir variação
      const { data: pv, error: pvError } = await admin
        .from('product_variations')
        .insert({
          product_id: productId,
          sku_variation: v.sku_variation,
          cost_override: v.cost_override ?? null,
          price_override: v.price_override ?? null,
          active: true,
        } as any)
        .select('id')
        .single() as unknown as { data: { id: number } | null; error: any }

      if (pvError || !pv) {
        const msg = pvError?.code === '23505'
          ? `SKU de variação "${v.sku_variation}" já existe.`
          : pvError?.message ?? 'Erro ao criar variação.'
        return NextResponse.json({ error: msg }, { status: 500 })
      }

      // Montar atributos (cor e/ou tamanho)
      const attrs: { product_variation_id: number; variation_type_id: number; variation_value_id: number }[] = []

      if (v.color_value_id) {
        const { data: colorType } = await admin
          .from('variation_values')
          .select('variation_type_id')
          .eq('id', v.color_value_id)
          .single() as unknown as { data: { variation_type_id: number } | null }

        if (colorType) {
          attrs.push({
            product_variation_id: pv.id,
            variation_type_id: colorType.variation_type_id,
            variation_value_id: v.color_value_id,
          })
        }
      }

      if (v.size_value_id) {
        const { data: sizeType } = await admin
          .from('variation_values')
          .select('variation_type_id')
          .eq('id', v.size_value_id)
          .single() as unknown as { data: { variation_type_id: number } | null }

        if (sizeType) {
          attrs.push({
            product_variation_id: pv.id,
            variation_type_id: sizeType.variation_type_id,
            variation_value_id: v.size_value_id,
          })
        }
      }

      if (attrs.length > 0) {
        const { error: attrError } = await admin
          .from('product_variation_attributes')
          .insert(attrs as any)

        if (attrError) return NextResponse.json({ error: attrError.message }, { status: 500 })
      }

      // Criar registro de estoque com quantidade 0
      const { error: stockError } = await admin
        .from('stock')
        .insert({
          product_variation_id: pv.id,
          quantity: 0,
          avg_cost: v.cost_override ?? productFields.base_cost,
          last_updated: new Date().toISOString(),
        } as any)

      if (stockError) return NextResponse.json({ error: stockError.message }, { status: 500 })
    }
  }

  const after = await getProductSnapshot(productId)
  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'product', resourceId: productId,
    before: before ?? undefined,
    after:  after  ?? undefined,
  })
  return NextResponse.json({ ok: true, id: productId, ...(priceWarning ? { warning: priceWarning } : {}) })
}

// ─── DELETE /api/produtos/[id] ────────────────────────────────────────────────

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  const productId = parseId(params.id)
  if (!productId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  // Snapshot para auditoria (before)
  const before = await getProductSnapshot(productId)

  // Verificar regras de negócio: estoque + vendas
  const check = await canDeleteProduct(productId)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

  // Executar exclusão em cascata via service
  const del = await deleteProductCascade(productId, check.data.variationIds)
  if (!del.ok) return NextResponse.json({ error: del.error }, { status: del.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'product', resourceId: productId,
    before: before ?? undefined,
  })
  return NextResponse.json({ ok: true })
}
