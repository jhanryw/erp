export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { generateParentSKU, generateSKUFromCodes, SKU_ANO } from '@/lib/sku/sku-map'
import { getOrCreateColorSkuCode, getOrCreateSizeSkuCode } from '@/lib/sku/sku-dynamic'
import { listActiveProductTypes, loadModeloGovernanceForAllTypes, buildDynamicSkuBase } from '@/lib/sku/sku-modelo-dynamic'
import { resolveTipoModelo, type ResolvedTipoModelo } from '@/lib/sku/resolve-taxonomy'

const variantSchema = z.object({
  color_value_id: z.number().int().positive().nullable().optional(),
  color_name:     z.string().min(1).nullable().optional(),
  size_value_id:  z.number().int().positive().nullable().optional(),
  size_name:      z.string().min(1).nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override:  z.coerce.number().min(0).nullable().optional(),
  initial_stock:  z.coerce.number().int().min(0).default(0),
})

// modelo é opcional no schema — Tipos governados dinamicamente podem ter
// Modelo opcional (ex.: Sex Shop, type_attributes.required=false). A
// obrigatoriedade real é decidida por resolveTipoModelo, consultando o PIM
// (ou o mapa legado, pra Tipos ainda não migrados) — nunca hardcoded aqui.
const productSchema = z.object({
  name:        z.string().min(2),
  tipo:        z.string().min(1),
  modelo:      z.string().optional(),
  ano:         z.string().min(1),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin:      z.enum(['own_brand', 'third_party']),
  base_cost:   z.coerce.number().min(0),
  base_price:  z.coerce.number().positive(),
  active:      z.boolean().default(true),
  variants:    z.array(variantSchema).optional(),
})

const importRequestSchema = z.object({
  products:        z.array(productSchema),
  idempotency_key: z.string().min(1).max(200).optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  // Compatível com o formato antigo (array puro) e o novo ({products, idempotency_key})
  const normalizedBody = Array.isArray(body) ? { products: body } : body
  const parsedBody = importRequestSchema.safeParse(normalizedBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Dados inválidos.', details: parsedBody.error.flatten() }, { status: 422 })
  }
  const { products: items, idempotency_key: idempotencyKey } = parsedBody.data

  if (items.length === 0) {
    return NextResponse.json({ error: 'Nenhum produto para importar.' }, { status: 400 })
  }

  const admin = createAdminClient()

  // ─── Fase 1: resolução e pré-validação — nenhuma escrita no banco ────────────
  const preflight: string[] = []

  const productTypes = await listActiveProductTypes(user.company_id, admin)
  const { governanceByTipoSlug, explicitlyNotUsedTipoSlugs } =
    await loadModeloGovernanceForAllTypes(productTypes, user.company_id, admin)

  const { data: modeloTypeRow } = await admin
    .from('variation_types')
    .select('id')
    .eq('slug', 'modelo')
    .maybeSingle()
  const modeloVariationTypeId = (modeloTypeRow as { id: number } | null)?.id ?? null

  const resolvedRows: (ResolvedTipoModelo | null)[] = items.map((item, idx) => {
    const rowNum = idx + 1
    const resolution = resolveTipoModelo(
      item.tipo, item.modelo ?? '', productTypes, governanceByTipoSlug, explicitlyNotUsedTipoSlugs,
    )
    if (!resolution.ok) {
      preflight.push(`Produto "${item.name}" (linha ${rowNum}): ${resolution.error}`)
      return null
    }
    if (!SKU_ANO[String(item.ano).trim()]) {
      const anosValidos = Object.keys(SKU_ANO).filter(k => k.length === 4).join(', ')
      preflight.push(`Produto "${item.name}" (linha ${rowNum}): Ano '${item.ano}' não suportado. Anos válidos: ${anosValidos}`)
      return null
    }
    return resolution.result
  })

  // Duplicatas dentro do próprio CSV — chave por Tipo/Modelo já resolvidos
  const requestKeys = new Map<string, string>()
  items.forEach((item, idx) => {
    const resolved = resolvedRows[idx]
    if (!resolved) return
    const key = `${item.name.toLowerCase().trim()}|${resolved.tipo}|${resolved.modelo}|${item.ano}`
    if (requestKeys.has(key)) {
      preflight.push(`Produto duplicado no CSV: "${item.name}" (${item.tipo} / ${item.modelo} / ${item.ano})`)
    } else {
      requestKeys.set(key, item.name)
    }
  })

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

  items.forEach((item, idx) => {
    const resolved = resolvedRows[idx]
    if (!resolved) return
    const key = `${item.name.toLowerCase().trim()}|${resolved.tipo}|${resolved.modelo}|${item.ano}`
    if (existingKeys.has(key)) {
      preflight.push(`"${item.name}" (${item.tipo} / ${item.modelo} / ${item.ano}) já existe no ERP. Remova do CSV.`)
    }
  })

  if (preflight.length > 0) {
    return NextResponse.json({
      error: 'O CSV contém erros que impedem a importação. Nenhum produto foi salvo.',
      validationErrors: preflight,
      imported: 0,
    }, { status: 400 })
  }

  // ─── Fase 2: monta o payload JSONB e persiste com UMA chamada transacional ───
  // Nenhum insert é feito diretamente aqui — resolução de cor/tamanho e
  // cálculo de SKU-base seguem em Node (mesma lógica de sempre, sem
  // duplicar regra), mas a escrita em si (products, product_attribute_values,
  // product_variations, product_variation_attributes, stock,
  // stock_movements) acontece inteira dentro de rpc_import_products_batch —
  // qualquer falha desfaz o lote inteiro via ROLLBACK do Postgres, sem
  // DELETE compensatório.
  const payloadProducts: Record<string, unknown>[] = []

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    const resolved = resolvedRows[idx]! // garantido não-nulo: preflight já bloquearia antes
    const { variants, ...rawProductData } = item

    const skuScheme: 'legacy' | 'dynamic' = resolved.productTypeId ? 'dynamic' : 'legacy'

    const parentSku = skuScheme === 'dynamic'
      ? buildDynamicSkuBase({ tipoSkuCode: resolved.tipoSkuCode!, modeloSkuCode: resolved.modeloSkuCode, ano: rawProductData.ano })
      : generateParentSKU(resolved.tipo, resolved.modelo, rawProductData.ano)

    const payloadVariants: Record<string, unknown>[] = []

    for (let vIdx = 0; vIdx < (variants ?? []).length; vIdx++) {
      const v = (variants ?? [])[vIdx]
      let colorValueId: number | null = null
      let colorVariationTypeId: number | null = null
      let colorSkuCode: string | undefined
      let sizeValueId: number | null = null
      let sizeVariationTypeId: number | null = null
      let sizeSkuCode: string | undefined

      if (v.color_value_id) {
        const { data: colorType } = (await admin
          .from('variation_values')
          .select('variation_type_id, value, sku_code')
          .eq('id', v.color_value_id)
          .single()) as unknown as { data: { variation_type_id: number; value: string; sku_code: string | null } | null }

        if (colorType) {
          colorSkuCode = colorType.sku_code ?? await getOrCreateColorSkuCode(colorType.value, admin)
          colorValueId = v.color_value_id
          colorVariationTypeId = colorType.variation_type_id
        }
      } else if (v.color_name) {
        colorSkuCode = await getOrCreateColorSkuCode(v.color_name, admin)
        const { data: colorRow } = (await admin
          .from('variation_values')
          .select('id, variation_type_id')
          .eq('normalized_name', v.color_name.toLowerCase().trim().replace(/\s+/g, '_'))
          .limit(1)
          .single()) as unknown as { data: { id: number; variation_type_id: number } | null }
        if (colorRow) {
          colorValueId = colorRow.id
          colorVariationTypeId = colorRow.variation_type_id
        }
      }

      if (v.size_value_id) {
        const { data: sizeType } = (await admin
          .from('variation_values')
          .select('variation_type_id, value, sku_code')
          .eq('id', v.size_value_id)
          .single()) as unknown as { data: { variation_type_id: number; value: string; sku_code: string | null } | null }

        if (sizeType) {
          sizeSkuCode = sizeType.sku_code ?? await getOrCreateSizeSkuCode(sizeType.value, admin)
          sizeValueId = v.size_value_id
          sizeVariationTypeId = sizeType.variation_type_id
        }
      } else if (v.size_name) {
        sizeSkuCode = await getOrCreateSizeSkuCode(v.size_name, admin)
        const { data: sizeRow } = (await admin
          .from('variation_values')
          .select('id, variation_type_id')
          .eq('normalized_name', v.size_name.toLowerCase().trim().replace(/\s+/g, '_'))
          .limit(1)
          .single()) as unknown as { data: { id: number; variation_type_id: number } | null }
        if (sizeRow) {
          sizeValueId = sizeRow.id
          sizeVariationTypeId = sizeRow.variation_type_id
        }
      }

      const skuBase = skuScheme === 'dynamic'
        ? buildDynamicSkuBase({
            tipoSkuCode:   resolved.tipoSkuCode!,
            modeloSkuCode: resolved.modeloSkuCode,
            corCode:       colorSkuCode,
            tamanhoCode:   sizeSkuCode,
            ano:           rawProductData.ano,
          })
        : generateSKUFromCodes({
            tipo:        resolved.tipo,
            modelo:      resolved.modelo,
            corCode:     colorSkuCode,
            tamanhoCode: sizeSkuCode,
            ano:         rawProductData.ano,
          })

      payloadVariants.push({
        client_index:          vIdx,
        sku_base:              skuBase,
        color_value_id:        colorValueId,
        color_variation_type_id: colorVariationTypeId,
        size_value_id:         sizeValueId,
        size_variation_type_id: sizeVariationTypeId,
        cost_override:         v.cost_override ?? null,
        price_override:        v.price_override ?? null,
        initial_stock:         v.initial_stock,
      })
    }

    payloadProducts.push({
      client_index:              idx,
      name:                      rawProductData.name,
      tipo:                      resolved.tipo,
      modelo:                    resolved.modelo,
      ano:                       rawProductData.ano,
      category_id:               rawProductData.category_id,
      supplier_id:               rawProductData.supplier_id ?? null,
      brand_id:                  null,
      origin:                    rawProductData.origin,
      base_cost:                 rawProductData.base_cost,
      base_price:                rawProductData.base_price,
      active:                    rawProductData.active,
      sku_base:                  parentSku,
      sku_scheme:                skuScheme,
      modelo_variation_type_id:  skuScheme === 'dynamic' && resolved.modeloValueId ? modeloVariationTypeId : null,
      modelo_value_id:           resolved.modeloValueId ?? null,
      variants:                  payloadVariants,
    })
  }

  const { data: rpcResult, error: rpcError } = await (admin as any).rpc('rpc_import_products_batch', {
    p_company_id:      user.company_id,
    p_system_user_id:  user.id,
    p_products:        payloadProducts,
    p_idempotency_key: idempotencyKey ?? null,
  }) as unknown as {
    data: { imported: number; products: unknown[] } | null
    error: { code: string; message: string } | null
  }

  if (rpcError) {
    // A transação foi revertida pelo próprio Postgres — nenhum produto
    // deste lote foi salvo, sem depender de DELETE compensatório.
    return NextResponse.json({
      error: `${rpcError.message} Importação cancelada. Nenhum produto foi salvo porque a transação foi revertida pelo banco.`,
      imported: 0,
    }, { status: rpcError.code === 'P0001' ? 400 : 500 })
  }

  const imported = rpcResult?.imported ?? 0

  auditLog({
    userId:   user.id,
    userRole: user.role,
    action:   'create',
    resource: 'product',
    detail:   `Importação CSV: ${imported} produtos`,
  })

  return NextResponse.json({
    message:  `${imported} produto${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''} com sucesso.`,
    imported,
  }, { status: 201 })
}
