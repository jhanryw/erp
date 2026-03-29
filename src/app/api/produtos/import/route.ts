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

const productSchema = z.object({
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

const importSchema = z.array(productSchema)

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = importSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()
  const results = { imported: 0, errors: [] as string[] }

  for (const item of parsed.data) {
    const { variants, ...productData } = item

    try {
      const parentSku = generateParentSKU(productData.tipo, productData.modelo)

      // 1. Criar produto
      const { data: product, error: productError } = (await admin
        .from('products')
        .insert({
          ...productData,
          sku: parentSku,
          supplier_id: productData.supplier_id ?? null,
          subcategory_id: null,
          collection_id: null,
        } as any)
        .select('id')
        .single()) as unknown as { data: { id: number } | null; error: any }

      if (productError) {
        throw new Error(
          `Produto ${productData.name}: ` +
            (productError.code === '23505'
              ? 'SKU já cadastrado.'
              : productError.code === '23503'
              ? 'Categoria ou fornecedor inválido.'
              : productError.message)
        )
      }

      // 2. Criar variantes (se houver)
      if (variants && variants.length > 0 && product) {
        for (const v of variants) {
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

          const varSku = generateSKU({ tipo: productData.tipo, modelo: productData.modelo, cor: colorValue || '00', tamanho: sizeValue || '00' })

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
            throw new Error(`Erro ao criar variante: ${pvError?.message}`)
          }

          if (attrs.length > 0) {
            const finalAttrs = attrs.map(a => ({ ...a, product_variation_id: pv.id }))
            await admin.from('product_variation_attributes').insert(finalAttrs as any)
          }

          // 3. Criar registro de estoque (Opção B confirmada)
          // Documentação: O saldo inicial é inserido diretamente na tabela 'stock' 
          // sem passar por 'rpc_stock_entry' (Options A). Isso é um comportamento intencional 
          // para caracterizar "carga inicial pré-operação" sem poluir os lotes de 
          // entrada formal e o audit financeiro. Entradas futuras usarão o fluxo normal.
          await admin.from('stock').insert({
            product_variation_id: pv.id,
            quantity: v.initial_stock,
            avg_cost: v.cost_override ?? productData.base_cost,
            last_updated: new Date().toISOString(),
          } as any)
        }
      }

      results.imported++
    } catch (err: any) {
      results.errors.push(err.message)
    }
  }

  auditLog({
    userId: user.id,
    userRole: user.role,
    action: 'create',
    resource: 'product',
    detail: `Importou ${results.imported} produtos. Erros: ${results.errors.length}`,
  })

  // Retorna sucesso parcial ou total
  return NextResponse.json({
    message: `Importou ${results.imported} produtos. ${results.errors.length} erros.`,
    errors: results.errors,
    imported: results.imported,
  }, { status: 200 })
}
