export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { canDeleteProduct, deleteProductCascade, getProductSnapshot, checkPriceChange } from '@/services/produtos.service'
import { generateSKUFromCodes } from '@/lib/sku/sku-map'
import { getOrCreateColorSkuCode, getOrCreateSizeSkuCode } from '@/lib/sku/sku-dynamic'
import { insertVariationWithRetry } from '@/lib/sku/sku-unique'
import { initializeStock } from '@/services/estoque.service'
import { NextResponse } from 'next/server'
import { buildVariationOverridePatch } from './buildVariationOverridePatch'
import { putSchema } from './putSchema'

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
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const productId = parseId(params.id)
  if (!productId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()

  const { data: product, error: productError } = await (admin as any)
    .from('products')
    .select('id, name, sku, category_id, supplier_id, brand_id, origin, base_cost, base_price, active, photo_url, ncm, cest, origem, unidade_med, wholesale_price')
    .eq('id', productId)
    .eq('company_id', user.company_id)
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
      wholesale_price_override,
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
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

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
    const flat = parsed.error.flatten()
    // parsed.error.flatten() é um OBJETO ({formErrors, fieldErrors}) — nunca
    // devolver isso direto como `error` (frontend espera string; um objeto
    // aí vira "Erro desconhecido" na tela, escondendo a causa real).
    const summary = [
      ...flat.formErrors,
      ...Object.entries(flat.fieldErrors).flatMap(
        ([field, msgs]) => (msgs ?? []).map((m) => `${field}: ${m}`)
      ),
    ].join(' | ') || 'Dados inválidos.'
    console.error('[produtos][PUT] validação zod falhou', { produtoId: productId, body, flat })
    return NextResponse.json({ error: summary, details: flat }, { status: 422 })
  }

  const { variations_to_delete, variations_to_add, variations_to_update, ...patch } = parsed.data

  // Snapshot antes para auditoria — também verifica que o produto pertence à empresa
  const before = await getProductSnapshot(productId, user.company_id)
  if (!before) return NextResponse.json({ error: 'Produto não encontrado' }, { status: 404 })

  // ── Merge: payload parcial + valores atuais do banco ────────────────────────
  // Campos ausentes no payload herdam o valor atual do produto.
  // Isso permite PUT parcial: { name: "Novo nome" } sem enviar todos os campos.
  type ProductSnap = {
    name: string; sku: string; category_id: number; supplier_id: number | null; brand_id: number | null
    origin: 'own_brand' | 'third_party'; base_cost: number; base_price: number; active: boolean
    ncm: string | null; cest: string | null; origem: number | null; unidade_med: string
    wholesale_price: number | null
  }
  const snap = before as unknown as ProductSnap
  const productFields = {
    name:        patch.name        ?? snap.name,
    sku:         patch.sku         ?? snap.sku,
    category_id: patch.category_id ?? snap.category_id,
    // supplier_id/brand_id podem ser null intencionalmente (remover vínculo);
    // distinguir "não enviado" (undefined) de "enviado como null"
    supplier_id: patch.supplier_id !== undefined ? (patch.supplier_id ?? null) : (snap.supplier_id ?? null),
    brand_id:    patch.brand_id    !== undefined ? (patch.brand_id    ?? null) : (snap.brand_id    ?? null),
    origin:      patch.origin      ?? snap.origin,
    base_cost:   patch.base_cost   ?? snap.base_cost,
    base_price:  patch.base_price  ?? snap.base_price,
    active:      patch.active      ?? snap.active,
    // campos fiscais: null é intencional (limpar), undefined = não enviado → mantém banco
    ncm:         patch.ncm    !== undefined ? patch.ncm    : snap.ncm,
    cest:        patch.cest   !== undefined ? patch.cest   : snap.cest,
    origem:      patch.origem !== undefined ? patch.origem : snap.origem,
    unidade_med: patch.unidade_med ?? snap.unidade_med,
    // Fundação varejo/atacado (2026-08-31) — null é intencional (remover
    // preço de atacado), undefined = não enviado → mantém banco.
    wholesale_price: patch.wholesale_price !== undefined ? patch.wholesale_price : snap.wholesale_price,
  }

  // ── Detecção de alteração de SKU (para auditoria) ───────────────────────────
  // products.sku é o SKU mãe (TTMM0000AA) — agrupador por tipo/modelo/ano.
  // Não possui unicidade: dois produtos com cores diferentes geram o mesmo SKU mãe.
  // A unicidade real está em product_variations.sku_variation (SKU unitário).

  const oldSku = snap.sku
  const skuChanged = patch.sku !== undefined && patch.sku !== oldSku

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
      brand_id: productFields.brand_id ?? null,
      origin: productFields.origin,
      base_cost: productFields.base_cost,
      base_price: productFields.base_price,
      active: productFields.active,
      ncm:         productFields.ncm,
      cest:        productFields.cest,
      origem:      productFields.origem,
      unidade_med: productFields.unidade_med,
      wholesale_price: productFields.wholesale_price,
      ...(skuChanged ? { sku_source: 'manual' } : {}),
    })
    .eq('id', productId) as {
      error: { code: string; message: string; details?: string | null; hint?: string | null } | null
    }

  if (updateError) {
    const msg =
      updateError.code === '23503' ? 'Categoria ou fornecedor inválido.' :
      updateError.message
    return NextResponse.json({
      error:   msg,
      code:    updateError.code    ?? null,
      details: updateError.details ?? null,
      hint:    updateError.hint    ?? null,
    }, { status: 500 })
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

  // ── 2b. Atualizar overrides (preço varejo/atacado) de variações existentes ──
  // Edição manual — grava exatamente nas mesmas colunas usadas pelo CSV
  // (import-parser.ts) e lidas pelo PDV/site (resolveSalePrice.ts):
  // product_variations.price_override / wholesale_price_override.

  if (variations_to_update && variations_to_update.length > 0) {
    for (const upd of variations_to_update) {
      const { data: varCheck, error: varCheckError } = await admin
        .from('product_variations')
        .select('id')
        .eq('id', upd.id)
        .eq('product_id', productId)
        .maybeSingle() as unknown as { data: { id: number } | null; error: any }

      if (varCheckError) return NextResponse.json({ error: varCheckError.message }, { status: 500 })

      if (!varCheck) {
        return NextResponse.json(
          { error: `Variação #${upd.id} não pertence a este produto.` },
          { status: 400 }
        )
      }

      const overridePatch = buildVariationOverridePatch(upd)
      if (Object.keys(overridePatch).length === 0) continue

      const { error: overrideUpdateError } = await (admin as any)
        .from('product_variations')
        .update(overridePatch)
        .eq('id', upd.id)

      if (overrideUpdateError) return NextResponse.json({ error: overrideUpdateError.message }, { status: 500 })
    }
  }

  // ── 3. Adicionar novas variações ────────────────────────────────────────────
  // SKU gerado no servidor via generateSKU() — nunca aceito do cliente.
  // Mesma lógica do POST /api/produtos, sem initial_stock (novas variações começam com 0).

  if (variations_to_add && variations_to_add.length > 0) {

    // Buscar tipo/modelo/ano do produto para gerar SKUs corretamente.
    // Esses campos são necessários pelo generateSKU() e ficam gravados no produto.
    const { data: productMeta, error: metaError } = await admin
      .from('products')
      .select('tipo, modelo, ano')
      .eq('id', productId)
      .single() as unknown as {
        data: { tipo: string; modelo: string; ano: string } | null
        error: { message: string } | null
      }

    if (metaError || !productMeta) {
      return NextResponse.json({ error: 'Produto não encontrado para geração de SKU.' }, { status: 404 })
    }

    if (!productMeta.tipo || !productMeta.modelo || !productMeta.ano) {
      return NextResponse.json(
        { error: 'Produto não possui tipo/modelo/ano definidos. Não é possível gerar SKU para novas variações.' },
        { status: 422 }
      )
    }

    for (const [variationIdx, v] of variations_to_add.entries()) {

      // Resolver sku_code de cor e tamanho a partir dos IDs
      let colorSkuCode: string | undefined
      let sizeSkuCode:  string | undefined

      const attrs: { product_variation_id: number; variation_type_id: number; variation_value_id: number }[] = []

      if (v.color_value_id) {
        const { data: colorType, error: colorLookupError } = await admin
          .from('variation_values')
          .select('variation_type_id, value, sku_code')
          .eq('id', v.color_value_id)
          .single() as unknown as {
            data: { variation_type_id: number; value: string; sku_code: string | null } | null
            error: { code: string; message: string; details?: string | null; hint?: string | null } | null
          }

        // Erro de consulta real (não "não encontrado") nunca deve ser
        // tratado silenciosamente como "sem cor" — isso geraria um SKU
        // errado sem avisar ninguém.
        if (colorLookupError) {
          console.error('[produtos][PUT] erro ao buscar cor da variação', {
            produtoId: productId, variationIdx, color_value_id: v.color_value_id, error: colorLookupError,
          })
          return NextResponse.json({
            error:   `Erro ao buscar cor da variação #${variationIdx + 1}: ${colorLookupError.message}`,
            code:    colorLookupError.code    ?? null,
            details: colorLookupError.details ?? null,
            hint:    colorLookupError.hint    ?? null,
          }, { status: 500 })
        }

        if (colorType) {
          colorSkuCode = colorType.sku_code ?? await getOrCreateColorSkuCode(colorType.value, admin)
          attrs.push({
            product_variation_id: 0,
            variation_type_id: colorType.variation_type_id,
            variation_value_id: v.color_value_id,
          })
        }
      }

      if (v.size_value_id) {
        const { data: sizeType, error: sizeLookupError } = await admin
          .from('variation_values')
          .select('variation_type_id, value, sku_code')
          .eq('id', v.size_value_id)
          .single() as unknown as {
            data: { variation_type_id: number; value: string; sku_code: string | null } | null
            error: { code: string; message: string; details?: string | null; hint?: string | null } | null
          }

        if (sizeLookupError) {
          console.error('[produtos][PUT] erro ao buscar tamanho da variação', {
            produtoId: productId, variationIdx, size_value_id: v.size_value_id, error: sizeLookupError,
          })
          return NextResponse.json({
            error:   `Erro ao buscar tamanho da variação #${variationIdx + 1}: ${sizeLookupError.message}`,
            code:    sizeLookupError.code    ?? null,
            details: sizeLookupError.details ?? null,
            hint:    sizeLookupError.hint    ?? null,
          }, { status: 500 })
        }

        if (sizeType) {
          sizeSkuCode = sizeType.sku_code ?? await getOrCreateSizeSkuCode(sizeType.value, admin)
          attrs.push({
            product_variation_id: 0,
            variation_type_id: sizeType.variation_type_id,
            variation_value_id: v.size_value_id,
          })
        }
      }

      // Gerar SKU base no servidor — nunca usa valor vindo do cliente
      let baseSku: string
      try {
        baseSku = generateSKUFromCodes({
          tipo:         productMeta.tipo,
          modelo:       productMeta.modelo,
          corCode:      colorSkuCode,
          tamanhoCode:  sizeSkuCode,
          ano:          productMeta.ano,
        })
      } catch (err) {
        console.error('[produtos][PUT] erro ao gerar SKU', {
          produtoId: productId, variationIdx,
          color_value_id: v.color_value_id, size_value_id: v.size_value_id,
          colorSkuCode, sizeSkuCode,
          erro: err instanceof Error ? err.message : String(err),
        })
        return NextResponse.json(
          { error: `Erro ao gerar SKU da variação #${variationIdx + 1}: ${err instanceof Error ? err.message : String(err)}` },
          { status: 422 }
        )
      }

      console.info('[produtos][PUT] SKU gerado para nova variação', {
        produtoId: productId, variationIdx,
        color_value_id: v.color_value_id, size_value_id: v.size_value_id,
        colorSkuCode, sizeSkuCode, baseSku,
      })

      // Inserir com desvio automático de sufixo + retry por race condition
      const insertResult = await insertVariationWithRetry(
        baseSku,
        {
          product_id:    productId,
          cost_override: v.cost_override ?? null,
          price_override: v.price_override ?? null,
          wholesale_price_override: v.wholesale_price_override ?? null,
          active: true,
        },
        admin,
      )

      if (!insertResult.ok) {
        console.error('[produtos][PUT] falha ao inserir variação', {
          produtoId: productId, variationIdx, baseSku, insertResult,
        })
        return NextResponse.json(
          {
            error:   `Falha ao salvar variação #${variationIdx + 1} (SKU base "${baseSku}"): ${insertResult.message}`,
            code:    insertResult.code    ?? null,
            details: insertResult.details ?? null,
            hint:    insertResult.hint    ?? null,
          },
          { status: insertResult.fatal ? 422 : 500 },
        )
      }

      const { pv } = insertResult

      // Inserir atributos (cor/tamanho) com o ID real da variação
      if (attrs.length > 0) {
        const finalAttrs = attrs.map(a => ({ ...a, product_variation_id: pv.id }))
        const { error: attrError } = await admin
          .from('product_variation_attributes')
          .insert(finalAttrs as any)

        if (attrError) return NextResponse.json({ error: attrError.message }, { status: 500 })
      }

      // Inicializar estoque via RPC (quantity=0 para novas variações adicionadas via PUT)
      // O trigger bloqueia INSERT direto na tabela stock — obrigatório usar RPC.
      const stockInit = await initializeStock({
        product_variation_id: pv.id,
        quantity:             0,
        avg_cost:             v.cost_override ?? productFields.base_cost,
      }, user.id)
      if (!stockInit.ok) {
        return NextResponse.json({ error: stockInit.error }, { status: stockInit.status })
      }
    }
  }

  const after = await getProductSnapshot(productId, user.company_id)

  // Auditoria específica de alteração de SKU — rastreabilidade obrigatória
  if (skuChanged) {
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'sku_manual_override', resource: 'product', resourceId: productId,
      before: { sku: oldSku },
      after:  { sku: productFields.sku },
      detail: `SKU alterado manualmente: ${oldSku} → ${productFields.sku}`,
    })
  }

  // Auditoria geral da atualização do produto
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
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const productId = parseId(params.id)
  if (!productId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  // Snapshot para auditoria — também verifica ownership
  const before = await getProductSnapshot(productId, user.company_id)
  if (!before) return NextResponse.json({ error: 'Produto não encontrado' }, { status: 404 })

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
