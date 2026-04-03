export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { generateSKU, generateParentSKU } from '@/lib/sku/sku-map'
import { insertVariationWithRetry } from '@/lib/sku/sku-unique'
import { initializeStock } from '@/services/estoque.service'

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
  ano: z.string().min(1),
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

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { variants, ...productData } = parsed.data

  const parentSku = generateParentSKU(productData.tipo, productData.modelo, productData.ano)

  const { data: product, error: productError } = (await (admin as any)
    .from('products')
    .insert({
      ...productData,
      sku: parentSku,
      supplier_id: productData.supplier_id ?? null,
      subcategory_id: null,
      collection_id: null,
      company_id: user.company_id,
    })
    .select('id')
    .single()) as unknown as { data: { id: number } | null; error: { code: string; message: string } | null }

  if (productError) {
    const msg =
      productError.code === '23503'
        ? 'Categoria ou fornecedor inválido.'
        : productError.message

    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // 2. Criar variantes (se houver)
  // Wrapped em try/catch: qualquer falha aqui (generateSKU, pvError, stockInit)
  // faz o produto recém-criado ser removido para evitar estado parcial no banco.
  if (variants && variants.length > 0 && product) {
    try {
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
              variation_type_id: sizeType.variation_type_id,
              variation_value_id: v.size_value_id,
            })
          }
        }

        // Pode lançar se colorValue/sizeValue não estiverem no mapa de SKUs
        const baseSku = generateSKU({ tipo: productData.tipo, modelo: productData.modelo, cor: colorValue || undefined, tamanho: sizeValue || undefined, ano: productData.ano })

        // Insere com desvio automático de sufixo + retry por race condition
        const insertResult = await insertVariationWithRetry(
          baseSku,
          {
            product_id:    product.id,
            cost_override: v.cost_override ?? null,
            price_override: v.price_override ?? null,
            active: true,
          },
          admin,
        )

        if (!insertResult.ok) {
          throw new Error(`Erro ao criar variante (base ${baseSku}): ${insertResult.message}`)
        }

        const { pv } = insertResult

        if (attrs.length > 0) {
          const finalAttrs = attrs.map(a => ({ ...a, product_variation_id: pv.id }))
          await admin.from('product_variation_attributes').insert(finalAttrs as any)
        }

        // 2c. Carga inicial via RPC — gera movimento 'initial' se quantity > 0,
        // sem stock_lot nem finance_entry (pré-operação). Trigger bloqueia insert direto.
        const stockInit = await initializeStock({
          product_variation_id: pv.id,
          quantity: v.initial_stock,
          avg_cost: v.cost_override ?? productData.base_cost,
        }, user.id)
        if (!stockInit.ok) {
          throw new Error(stockInit.error ?? 'Erro ao inicializar estoque da variante.')
        }
      }
    } catch (variantErr) {
      // Rollback: remover o produto recém-criado para não deixar estado parcial.
      // A FK em product_variations cascateia para variantes e stock já criados.
      await (admin as any).from('products').delete().eq('id', product.id)
      console.error('[POST /api/produtos] Rollback executado — produto removido por falha nas variantes', variantErr)
      const msg = variantErr instanceof Error ? variantErr.message : 'Erro ao criar variantes do produto.'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  auditLog({ userId: user.id, userRole: user.role, action: 'create', resource: 'product', resourceId: product?.id, detail: parentSku })
  return NextResponse.json({ product }, { status: 201 })
}
