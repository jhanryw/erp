export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { generateParentSKU, generateSKUFromCodes } from '@/lib/sku/sku-map'
import { getOrCreateColorSkuCode, getOrCreateSizeSkuCode } from '@/lib/sku/sku-dynamic'
import { insertVariationWithRetry } from '@/lib/sku/sku-unique'
import { initializeStock } from '@/services/estoque.service'

const variantSchema = z.object({
  color_value_id: z.number().int().positive().nullable().optional(),
  color_name:     z.string().min(1).nullable().optional(),   // usado quando a cor não existe ainda
  size_value_id:  z.number().int().positive().nullable().optional(),
  size_name:      z.string().min(1).nullable().optional(),   // usado quando o tamanho não existe ainda
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override:  z.coerce.number().min(0).nullable().optional(),
  initial_stock:  z.coerce.number().int().min(0).default(0),
})

const productSchema = z.object({
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

const importSchema = z.array(productSchema)

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

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
      const parentSku = generateParentSKU(productData.tipo, productData.modelo, productData.ano)

      // 1. Criar produto — se já existir (mesmo SKU = reposição), usa o existente
      let product: { id: number } | null = null

      const { data: insertedProduct, error: productError } = (await admin
        .from('products')
        .insert({
          ...productData,
          sku: parentSku,
          supplier_id: productData.supplier_id ?? null,
          subcategory_id: null,
          collection_id: null,
          company_id: user.company_id,
        } as any)
        .select('id')
        .single()) as unknown as { data: { id: number } | null; error: any }

      if (productError) {
        if (productError.code === '23505') {
          // Produto já existe — busca pelo SKU para reposição de estoque
          const { data: existing } = (await admin
            .from('products')
            .select('id')
            .eq('sku', parentSku)
            .single()) as unknown as { data: { id: number } | null }
          if (existing) {
            product = existing
          } else {
            throw new Error(`Produto ${productData.name}: já existe mas não foi possível localizá-lo.`)
          }
        } else {
          throw new Error(
            `Produto ${productData.name}: ` +
              (productError.code === '23503'
                ? 'Categoria ou fornecedor inválido.'
                : productError.message)
          )
        }
      } else {
        product = insertedProduct
      }

      // 2. Criar variantes (se houver)
      if (variants && variants.length > 0 && product) {
        for (const v of variants) {
          const attrs: any[] = []
          let colorSkuCode: string | undefined
          let sizeSkuCode:  string | undefined

          // Cor: resolve por ID (existente) ou por nome (cria se não existir)
          if (v.color_value_id) {
            const { data: colorType } = (await admin
              .from('variation_values')
              .select('variation_type_id, value, sku_code')
              .eq('id', v.color_value_id)
              .single()) as unknown as { data: { variation_type_id: number; value: string; sku_code: string | null } | null }

            if (colorType) {
              colorSkuCode = colorType.sku_code ?? await getOrCreateColorSkuCode(colorType.value, admin)
              attrs.push({ variation_type_id: colorType.variation_type_id, variation_value_id: v.color_value_id })
            }
          } else if (v.color_name) {
            const result = await getOrCreateColorSkuCode(v.color_name, admin)
            colorSkuCode = result
            // Buscar o ID que foi criado/encontrado
            const { data: colorRow } = (await admin
              .from('variation_values')
              .select('id, variation_type_id')
              .eq('normalized_name', v.color_name.toLowerCase().trim().replace(/\s+/g, '_'))
              .limit(1)
              .single()) as unknown as { data: { id: number; variation_type_id: number } | null }
            if (colorRow) attrs.push({ variation_type_id: colorRow.variation_type_id, variation_value_id: colorRow.id })
          }

          // Tamanho: resolve por ID (existente) ou por nome (cria se não existir)
          if (v.size_value_id) {
            const { data: sizeType } = (await admin
              .from('variation_values')
              .select('variation_type_id, value, sku_code')
              .eq('id', v.size_value_id)
              .single()) as unknown as { data: { variation_type_id: number; value: string; sku_code: string | null } | null }

            if (sizeType) {
              sizeSkuCode = sizeType.sku_code ?? await getOrCreateSizeSkuCode(sizeType.value, admin)
              attrs.push({ variation_type_id: sizeType.variation_type_id, variation_value_id: v.size_value_id })
            }
          } else if (v.size_name) {
            const result = await getOrCreateSizeSkuCode(v.size_name, admin)
            sizeSkuCode = result
            const { data: sizeRow } = (await admin
              .from('variation_values')
              .select('id, variation_type_id')
              .eq('normalized_name', v.size_name.toLowerCase().trim().replace(/\s+/g, '_'))
              .limit(1)
              .single()) as unknown as { data: { id: number; variation_type_id: number } | null }
            if (sizeRow) attrs.push({ variation_type_id: sizeRow.variation_type_id, variation_value_id: sizeRow.id })
          }

          const baseSku = generateSKUFromCodes({
            tipo:        productData.tipo,
            modelo:      productData.modelo,
            corCode:     colorSkuCode,
            tamanhoCode: sizeSkuCode,
            ano:         productData.ano,
          })

          // Verificar se a variante já existe (reposição)
          const { data: existingVariant } = (await admin
            .from('product_variations')
            .select('id')
            .eq('product_id', product.id)
            .like('sku_variation', `${baseSku}%`)
            .limit(1)
            .single()) as unknown as { data: { id: number } | null }

          let pvId: number

          if (existingVariant) {
            // Variante já existe → apenas soma o estoque (reposição)
            pvId = existingVariant.id
          } else {
            // Variante nova → cria normalmente
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

            pvId = insertResult.pv.id

            if (attrs.length > 0) {
              await admin.from('product_variation_attributes').insert(
                attrs.map(a => ({ ...a, product_variation_id: pvId })) as any
              )
            }
          }

          // 3. Carga/reposição de estoque via RPC
          if (v.initial_stock > 0) {
            const stockInit = await initializeStock({
              product_variation_id: pvId,
              quantity: v.initial_stock,
              avg_cost: v.cost_override ?? productData.base_cost,
            }, user.id)
            if (!stockInit.ok) {
              throw new Error(`Erro ao registrar estoque: ${stockInit.error}`)
            }
          }
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
