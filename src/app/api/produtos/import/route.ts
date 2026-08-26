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
import { ncmFieldSchema, origemFieldSchema, wholesalePriceFieldSchema } from '@/lib/validators'

const variantSchema = z.object({
  color_value_id: z.number().int().positive().nullable().optional(),
  color_name:     z.string().min(1).nullable().optional(),
  size_value_id:  z.number().int().positive().nullable().optional(),
  size_name:      z.string().min(1).nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override:  z.coerce.number().min(0).nullable().optional(),
  // Fundação varejo/atacado (2026-08-31) — espelha price_override.
  wholesale_price_override: z.coerce.number().positive().nullable().optional(),
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
  // Fundação varejo/atacado (2026-08-31) — reaproveita os mesmos
  // validators já usados na criação/edição manual de produto
  // (src/lib/validators/index.ts), nunca duplica a regra.
  wholesale_price: wholesalePriceFieldSchema(),
  ncm:             ncmFieldSchema('NCM deve ter exatamente 8 dígitos'),
  origem_fiscal:   origemFieldSchema(),
  cst:             z.preprocess((v) => (v === '' || v == null ? null : String(v).trim()), z.string().max(10).nullable().optional()),
  variants:    z.array(variantSchema).optional(),
})

// Conclusão da fundação varejo/atacado (2026-09-01) — linha de UPDATE por
// SKU. Todos os campos além de client_index/sku são opcionais — a AUSÊNCIA
// da chave (não `null`) é o que faz o servidor (_update_single_product_by_
// sku) não tocar aquela coluna (semântica de PATCH, célula vazia nunca
// apaga valor existente). Por isso NENHUM campo aqui tem `.nullable()` —
// só `.optional()`: se o cliente mandar `null` explícito, o Zod rejeita
// (mais seguro do que silenciosamente virar "não fornecido" por
// coincidência de implementação).
const updateSchema = z.object({
  client_index: z.number().int(),
  sku: z.string().min(1),
  price_override: z.coerce.number().positive().optional(),
  wholesale_price_override: z.coerce.number().positive().optional(),
  ncm: ncmFieldSchema('NCM deve ter exatamente 8 dígitos').transform(v => v ?? undefined),
  origem: origemFieldSchema().transform(v => v ?? undefined),
  cst: z.string().max(10).optional(),
})

const importRequestSchema = z.object({
  products:        z.array(productSchema).default([]),
  updates:         z.array(updateSchema).default([]),
  idempotency_key: z.string().min(1).max(200).optional(),
})

export async function POST(request: Request) {
  console.info('[IMPORT] request chegou')

  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) {
    console.warn('[IMPORT] bloqueado', 'auth: requireRole(gerente) negou acesso')
    return unauth
  }

  if (!user.company_id) {
    console.warn('[IMPORT] bloqueado', 'usuario sem company_id')
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch (e) {
    console.warn('[IMPORT] bloqueado', 'JSON invalido no corpo da requisicao')
    console.error('[IMPORT] erro ao parsear body', e)
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  // Compatível com o formato antigo (array puro) e o novo ({products, idempotency_key})
  const normalizedBody = Array.isArray(body) ? { products: body } : body
  const parsedBody = importRequestSchema.safeParse(normalizedBody)
  if (!parsedBody.success) {
    console.warn('[IMPORT] bloqueado', 'validacao zod falhou', parsedBody.error.flatten())
    return NextResponse.json({ error: 'Dados inválidos.', details: parsedBody.error.flatten() }, { status: 422 })
  }
  const { products: items, updates, idempotency_key: idempotencyKey } = parsedBody.data

  if (items.length === 0 && updates.length === 0) {
    console.warn('[IMPORT] bloqueado', 'payload vazio (products e updates ambos vazios)')
    return NextResponse.json({ error: 'Nenhum produto para importar ou atualizar.' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Conclusão da fundação varejo/atacado (2026-09-01) — CSV pode misturar
  // linhas de criação (sem sku) e atualização (com sku) no mesmo arquivo.
  // As duas fases rodam de forma independente e o resultado é combinado no
  // final: uma falha de criação (preflight ou RPC) NÃO impede que as
  // atualizações válidas do mesmo lote sejam processadas, e vice-versa —
  // são operações com fontes de verdade e identificadores diferentes
  // (nome+tipo+modelo+ano vs. sku_variation), não faz sentido acoplar o
  // sucesso de uma à da outra. idempotency_key ganha um sufixo distinto
  // por fase (":create"/":update") porque as duas fases usam a MESMA
  // tabela import_batches (company_id, idempotency_key) — reusar a chave
  // crua faria a segunda chamada colidir com o cache da primeira.
  let created = 0
  let createdProducts: unknown[] = []
  let createError: { message: string; validationErrors?: string[]; code?: string | null; details?: string | null; hint?: string | null } | null = null

  if (items.length > 0) {
    const result = await processCreateBatch({
      admin, items, companyId: user.company_id, systemUserId: user.id,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:create` : null,
    })
    if (result.ok) {
      created = result.created
      createdProducts = result.products
    } else {
      createError = result.error
    }
  }

  let updated = 0
  let updatedProducts: unknown[] = []
  let updateErrors: Array<{ client_index: number; sku: string | null; message: string }> = []
  let updateBlockedError: string | null = null

  if (updates.length > 0) {
    const { data: updateRpcResult, error: updateRpcError } = await (admin as any).rpc('rpc_update_products_by_sku_batch', {
      p_company_id:      user.company_id,
      p_system_user_id:  user.id,
      p_updates:         updates,
      p_idempotency_key: idempotencyKey ? `${idempotencyKey}:update` : null,
    }) as unknown as {
      data: { updated: number; errors: Array<{ client_index: number; sku: string | null; message: string }>; products: unknown[] } | null
      error: { code: string; message: string } | null
    }

    if (updateRpcError) {
      console.error('[IMPORT] erro RPC update', updateRpcError)
      updateBlockedError = updateRpcError.message
    } else {
      updated = updateRpcResult?.updated ?? 0
      updatedProducts = updateRpcResult?.products ?? []
      updateErrors = updateRpcResult?.errors ?? []
    }
  }

  const totalErrors = (createError ? 1 : 0) + updateErrors.length + (updateBlockedError ? 1 : 0)

  console.info('[IMPORT] resultado final', { created, updated, errors: totalErrors, createBlocked: !!createError, updateBlocked: !!updateBlockedError })

  if (created > 0 || updated > 0) {
    auditLog({
      userId:   user.id,
      userRole: user.role,
      action:   'create',
      resource: 'product',
      detail:   `Importação CSV: ${created} criados, ${updated} atualizados, ${totalErrors} erro(s)`,
    })
  }

  // 201 se algo foi persistido (criado ou atualizado), mesmo com erros
  // parciais — a UI decide como apresentar "sucesso parcial" a partir dos
  // campos abaixo, nunca a partir só do status HTTP.
  const status = created > 0 || updated > 0 ? 201 : 400

  return NextResponse.json({
    created,
    created_products: createdProducts,
    create_error: createError,
    updated,
    updated_products: updatedProducts,
    update_errors: updateErrors,
    update_blocked_error: updateBlockedError,
  }, { status })
}

// ─── Fase de criação (all-or-nothing, comportamento inalterado desde 20260812) ──
async function processCreateBatch({
  admin, items, companyId, systemUserId, idempotencyKey,
}: {
  admin: ReturnType<typeof createAdminClient>
  items: z.infer<typeof productSchema>[]
  companyId: number
  systemUserId: string
  idempotencyKey: string | null
}): Promise<
  | { ok: true; created: number; products: unknown[] }
  | { ok: false; error: { message: string; validationErrors?: string[]; code?: string | null; details?: string | null; hint?: string | null } }
> {

  console.info('[IMPORT] preflight iniciou', { idempotencyKey: idempotencyKey ?? null, quantidade: items.length })

  // ─── Fase 1: resolução e pré-validação — nenhuma escrita no banco ────────────
  const preflight: string[] = []

  const productTypes = await listActiveProductTypes(companyId, admin)
  const { governanceByTipoSlug, explicitlyNotUsedTipoSlugs } =
    await loadModeloGovernanceForAllTypes(productTypes, companyId, admin)

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
    .eq('company_id', companyId)) as unknown as {
    data: { name: string; tipo: string; modelo: string; ano: string }[] | null
    error: any
  }

  if (fetchError) {
    console.warn('[IMPORT] bloqueado', 'erro ao buscar produtos existentes no ERP')
    console.error('[IMPORT] erro fetch existingProducts', fetchError)
    return { ok: false, error: { message: 'Erro ao verificar produtos existentes no ERP.' } }
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
    console.warn('[IMPORT] bloqueado', 'preflight com erros', { quantidade: preflight.length, primeiros: preflight.slice(0, 3) })
    return {
      ok: false,
      error: { message: 'O CSV contém erros que impedem a criação de novos produtos. Nenhum produto novo foi salvo.', validationErrors: preflight },
    }
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
        wholesale_price_override: v.wholesale_price_override ?? null,
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
      // Fundação varejo/atacado (2026-08-31) — nomes de chave alinhados
      // com o que _persist_single_product lê (products.wholesale_price/
      // ncm/origem/cst). `origem_fiscal` (nome do campo CSV/schema, pra
      // não colidir com `origin` acima, que é fabricação própria/terceiro)
      // vira `origem` no payload — mesmo nome da coluna real no banco.
      wholesale_price:           rawProductData.wholesale_price ?? null,
      ncm:                       rawProductData.ncm ?? null,
      origem:                    rawProductData.origem_fiscal ?? null,
      cst:                       rawProductData.cst ?? null,
      sku_base:                  parentSku,
      sku_scheme:                skuScheme,
      modelo_variation_type_id:  skuScheme === 'dynamic' && resolved.modeloValueId ? modeloVariationTypeId : null,
      modelo_value_id:           resolved.modeloValueId ?? null,
      variants:                  payloadVariants,
    })
  }

  console.info('[IMPORT] payload pronto', {
    quantidade: payloadProducts.length,
    primeiroProduto: payloadProducts[0]
      ? { nome: payloadProducts[0].name, sku_base: payloadProducts[0].sku_base }
      : null,
  })

  // TEMPORÁRIO (diagnóstico de "numeric field overflow") — valores
  // numéricos reais enviados à RPC para o primeiro produto/variante do
  // lote. Nomes de campo iguais aos do payload (ver payloadProducts.push
  // acima) — nunca loga o payload inteiro nem dados de outros produtos.
  const firstProductLog  = payloadProducts[0] as Record<string, unknown> | undefined
  const firstVariantLog  = (firstProductLog?.variants as Record<string, unknown>[] | undefined)?.[0]
  console.info('[IMPORT] valores numericos', {
    produto: firstProductLog
      ? { base_cost: firstProductLog.base_cost, base_price: firstProductLog.base_price }
      : null,
    primeiraVariacao: firstVariantLog
      ? {
          cost_override:  firstVariantLog.cost_override,
          price_override: firstVariantLog.price_override,
          initial_stock:  firstVariantLog.initial_stock,
        }
      : null,
  })

  console.info('[IMPORT] chamando RPC', { idempotencyKey: idempotencyKey ?? null })

  const { data: rpcResult, error: rpcError } = await (admin as any).rpc('rpc_import_products_batch', {
    p_company_id:      companyId,
    p_system_user_id:  systemUserId,
    p_products:        payloadProducts,
    p_idempotency_key: idempotencyKey ?? null,
  }) as unknown as {
    data: { imported: number; products: unknown[] } | null
    error: { code: string; message: string; details?: string | null; hint?: string | null } | null
  }

  if (rpcError) {
    console.error('[IMPORT] erro RPC', rpcError)
    // A transação foi revertida pelo próprio Postgres — nenhum produto
    // deste lote foi salvo, sem depender de DELETE compensatório.
    return {
      ok: false,
      error: {
        // rpcError.message já vem com contexto de qual produto do lote
        // falhou (ver rpc_import_products_batch, migration 202607302700) —
        // "Falha ao importar produto "X" (client_index=N): <erro original>".
        message: `${rpcError.message} Nenhum produto novo foi salvo porque a transação foi revertida pelo banco.`,
        code:    rpcError.code ?? null,
        details: rpcError.details ?? null,
        hint:    rpcError.hint ?? null,
      },
    }
  }

  console.info('[IMPORT] RPC criação retornou', {
    imported:           rpcResult?.imported,
    produtosRetornados: Array.isArray(rpcResult?.products) ? rpcResult!.products.length : null,
  })

  return { ok: true, created: rpcResult?.imported ?? 0, products: rpcResult?.products ?? [] }
}
