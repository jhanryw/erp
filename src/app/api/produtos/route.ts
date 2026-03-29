export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { generateSKU, generateParentSKU } from '@/lib/sku/sku-map'

const variantSchema = z.object({
  color_value_id: z.number().int().positive().nullable().optional(),
  size_value_id: z.number().int().positive().nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override: z.coerce.number().min(0).nullable().optional(),
  initial_stock: z.coerce.number().int().min(0).default(0),
})

const schema = z.object({
  name: z.string().min(2),
  tipo: z.string().min(1),
  modelo: z.string().min(1),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0),
  base_price: z.coerce.number().positive(),
  active: z.boolean().default(true),
  variants: z.array(variantSchema).optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { variants, ...productData } = parsed.data

  const parentSku = generateParentSKU(productData.tipo, productData.modelo)

  // 1. Criar produto
  const { data: product, error: productError } = (await admin
    .from('products')
    .insert({ ...productData, sku: parentSku, supplier_id: productData.supplier_id ?? null, subcategory_id: null, collection_id: null } as any)
    .select('id')
    .single()) as unknown as { data: { id: number } | null; error: any }

  if (productError) {
    const msg = productError.code === '23505' ? 'SKU já cadastrado.' : productError.code === '23503' ? 'Categoria ou fornecedor inválido.' : productError.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // 2. Criar variantes (se houver)
  if (variants && variants.length > 0 && product) {
    for (const v of variants) {
      // 2b/a. Buscar atributos para compor o SKU e associar (cor e tamanho)
      const attrs: any[] = []
      let colorValue = ''
      let sizeValue = ''

      if (v.color_value_id) {
        const { data: colorType } = (await admin
          .from('variation_values')
          .select('variation_type_id, value')
          .eq('id', v.color_value_id)
          .single()) as unknown as { data: { variation_type_id: number, value: string } | null }

        if (colorType) {
          colorValue = colorType.value
          attrs.push({
            // placeholder, ID será repassado no final
            variation_type_id: colorType.variation_type_id,
            variation_value_id: v.color_value_id,
          })
        }
      }

      if (v.size_value_id) {
        const { data: sizeType } = (await admin
          .from('variation_values')
          .select('variation_type_id, value')
          .eq('id', v.size_value_id)
          .single()) as unknown as { data: { variation_type_id: number, value: string } | null }

        if (sizeType) {
          sizeValue = sizeType.value
          attrs.push({
            // placeholder
            variation_type_id: sizeType.variation_type_id,
            variation_value_id: v.size_value_id,
          })
        }
      }
      
      const varSku = generateSKU({ tipo: productData.tipo, modelo: productData.modelo, cor: colorValue || '00', tamanho: sizeValue || '00' })

      // 2a. Criar product_variation (agora que temos o sku gerado no servidor)
      const { data: pv, error: pvError } = (await admin
        .from('product_variations')
        .insert({
          product_id: product.id,
          sku_variation: varSku,
          cost_override: v.cost_override ?? null,
          price_override: v.price_override ?? null,
          active: true,
        } as any)
        .select('id')
        .single()) as unknown as { data: { id: number } | null; error: any }

      if (pvError || !pv) {
        return NextResponse.json({ error: `Erro ao criar variante: ${pvError?.message}` }, { status: 500 })
      }

      if (attrs.length > 0) {
        const finalAttrs = attrs.map(a => ({ ...a, product_variation_id: pv.id }))
        await admin.from('product_variation_attributes').insert(finalAttrs as any)
      }

      // 2c. Criar registro de estoque (Opção B - Carga Inicial Direta)
      // Como na importação, o saldo inicial (se houver) vai direto para a tabela `stock`
      // sem gerar histórico de entrada financeira formal. Entradas futuras usarão RPC.
      await admin.from('stock').insert({
        product_variation_id: pv.id,
        quantity: v.initial_stock,
        avg_cost: v.cost_override ?? productData.base_cost,
        last_updated: new Date().toISOString(),
      } as any)
    }
  }

  auditLog({ userId: user.id, userRole: user.role, action: 'create', resource: 'product', resourceId: product?.id, detail: parentSku })
  return NextResponse.json({ product }, { status: 201 })
}
