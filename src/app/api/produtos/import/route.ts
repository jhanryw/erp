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
  color_name:     z.string().min(1).nullable().optional(),
  size_value_id:  z.number().int().positive().nullable().optional(),
  size_name:      z.string().min(1).nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override:  z.coerce.number().min(0).nullable().optional(),
  initial_stock:  z.coerce.number().int().min(0).default(0),
})

const productSchema = z.object({
  name:        z.string().min(2),
  tipo:        z.string().min(1),
  modelo:      z.string().min(1),
  ano:         z.string().min(1),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin:      z.enum(['own_brand', 'third_party']),
  base_cost:   z.coerce.number().min(0),
  base_price:  z.coerce.number().positive(),
  active:      z.boolean().default(true),
  variants:    z.array(variantSchema).optional(),
})

const importSchema = z.array(productSchema)

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = importSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Dados inválidos.', details: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  // ─── Fase 1: pré-validação — nenhuma escrita no banco ────────────────────────
  const preflight: string[] = []

  // Duplicatas dentro do próprio CSV
  const requestKeys = new Map<string, string>()
  for (const item of parsed.data) {
    const key = `${item.name.toLowerCase().trim()}|${item.tipo}|${item.modelo}|${item.ano}`
    if (requestKeys.has(key)) {
      preflight.push(`Produto duplicado no CSV: "${item.name}" (${item.tipo} / ${item.modelo} / ${item.ano})`)
    } else {
      requestKeys.set(key, item.name)
    }
  }

  // Conflito com produtos já existentes no ERP
  const { data: existingProducts, error: fetchError } = (await admin
    .from('products')
    .select('name, tipo, modelo, ano')
    .eq('company_id', user.company_id)) as unknown as {
    data: { name: string; tipo: string; modelo: string; ano: string }[] | null
    error: any
  }

  if (fetchError) {
    return NextResponse.json({ error: 'Erro ao verificar produtos existentes no ERP.' }, { status: 500 })
  }

  const existingKeys = new Set(
    (existingProducts ?? []).map(p =>
      `${p.name.toLowerCase().trim()}|${p.tipo}|${p.modelo}|${p.ano}`
    )
  )

  for (const item of parsed.data) {
    const key = `${item.name.toLowerCase().trim()}|${item.tipo}|${item.modelo}|${item.ano}`
    if (existingKeys.has(key)) {
      preflight.push(`"${item.name}" (${item.tipo} / ${item.modelo} / ${item.ano}) já existe no ERP. Remova do CSV.`)
    }
  }

  if (preflight.length > 0) {
    return NextResponse.json({
      error: 'O CSV contém erros que impedem a importação. Nenhum produto foi salvo.',
      validationErrors: preflight,
      imported: 0,
    }, { status: 400 })
  }

  // ─── Fase 2: inserção em série — rollback suave em caso de falha ─────────────
  const insertedIds: number[] = []

  try {
    for (const item of parsed.data) {
      const { variants, ...productData } = item

      let parentSku: string
      try {
        parentSku = generateParentSKU(productData.tipo, productData.modelo, productData.ano)
      } catch {
        const hash = Buffer.from(productData.name).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()
        parentSku = `IMP${hash}${productData.ano ?? '00'}`
      }

      const { data: insertedProduct, error: productError } = (await admin
        .from('products')
        .insert({
          ...productData,
          sku:            parentSku,
          supplier_id:    productData.supplier_id ?? null,
          subcategory_id: null,
          collection_id:  null,
          company_id:     user.company_id,
        } as any)
        .select('id')
        .single()) as unknown as { data: { id: number } | null; error: any }

      if (productError) {
        const msg = productError.code === '23503'
          ? `Produto "${productData.name}": categoria ou fornecedor inválido.`
          : `Produto "${productData.name}": ${productError.message}`
        throw new Error(msg)
      }

      const product = insertedProduct!
      insertedIds.push(product.id)

      if (variants && variants.length > 0) {
        for (const v of variants) {
          const attrs: any[] = []
          let colorSkuCode: string | undefined
          let sizeSkuCode:  string | undefined

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
            colorSkuCode = await getOrCreateColorSkuCode(v.color_name, admin)
            const { data: colorRow } = (await admin
              .from('variation_values')
              .select('id, variation_type_id')
              .eq('normalized_name', v.color_name.toLowerCase().trim().replace(/\s+/g, '_'))
              .limit(1)
              .single()) as unknown as { data: { id: number; variation_type_id: number } | null }
            if (colorRow) attrs.push({ variation_type_id: colorRow.variation_type_id, variation_value_id: colorRow.id })
          }

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
            sizeSkuCode = await getOrCreateSizeSkuCode(v.size_name, admin)
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

          const insertResult = await insertVariationWithRetry(
            baseSku,
            {
              product_id:     product.id,
              cost_override:  v.cost_override  ?? null,
              price_override: v.price_override ?? null,
              active: true,
            },
            admin,
          )

          if (!insertResult.ok) {
            throw new Error(`Variante do produto "${productData.name}" (${baseSku}): ${insertResult.message}`)
          }

          const pvId = insertResult.pv.id

          if (attrs.length > 0) {
            await admin.from('product_variation_attributes').insert(
              attrs.map(a => ({ ...a, product_variation_id: pvId })) as any
            )
          }

          if (v.initial_stock > 0) {
            const stockInit = await initializeStock({
              product_variation_id: pvId,
              quantity:  v.initial_stock,
              avg_cost:  v.cost_override ?? productData.base_cost,
            }, user.id)
            if (!stockInit.ok) {
              throw new Error(`Estoque do produto "${productData.name}": ${stockInit.error}`)
            }
          }
        }
      }
    }
  } catch (err: any) {
    // Rollback suave: remove todos os produtos inseridos nesta importação.
    // A FK em product_variations cascateia para variantes, atributos e estoque.
    if (insertedIds.length > 0) {
      await admin.from('products').delete().in('id', insertedIds)
    }
    const msg = err instanceof Error ? err.message : 'Erro inesperado durante a importação.'
    return NextResponse.json({
      error: `${msg} Nenhum produto foi salvo (rollback executado).`,
      imported: 0,
    }, { status: 500 })
  }

  auditLog({
    userId:   user.id,
    userRole: user.role,
    action:   'create',
    resource: 'product',
    detail:   `Importação CSV: ${insertedIds.length} produtos`,
  })

  return NextResponse.json({
    message:  `${insertedIds.length} produto${insertedIds.length !== 1 ? 's' : ''} importado${insertedIds.length !== 1 ? 's' : ''} com sucesso.`,
    imported: insertedIds.length,
  }, { status: 201 })
}
