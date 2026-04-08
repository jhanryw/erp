import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProductFull,
  getMappedNuvemshopProduct,
  mapProductToNuvemshop,
  mapVariantToNuvemshop,
} from '@/lib/integrations/nuvemshop'

type AttributeRow = {
  variation_type_id:  number
  variation_value_id: number
  variation_types:    { name: string; slug: string } | null
  variation_values:   { value: string; slug: string } | null
}

type VariationRow = {
  id:                            number
  sku_variation:                 string | null
  product_variation_attributes:  AttributeRow[]
  stock:                         { quantity: number }[]
}

export async function POST(request: Request) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: { produto_id?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const produtoId = Number(body.produto_id)
  if (!produtoId) {
    return NextResponse.json({ error: 'produto_id obrigatório.' }, { status: 400 })
  }

  try {
    // ── Idempotência ─────────────────────────────────────────────────────────
    const existing = await getMappedNuvemshopProduct(produtoId)
    if (existing) {
      return NextResponse.json({ ok: true, external_id: existing.external_id, skipped: true })
    }

    const admin = createAdminClient()

    // ── Buscar produto ────────────────────────────────────────────────────────
    const { data: product, error: productError } = (await admin
      .from('products')
      .select('id, name, base_price, photo_url')
      .eq('id', produtoId)
      .single()) as unknown as {
        data: { id: number; name: string; base_price: number; photo_url: string | null } | null
        error: { message: string } | null
      }

    if (productError || !product) {
      return NextResponse.json({ error: 'Produto não encontrado.' }, { status: 404 })
    }

    // ── Buscar TODAS as variações com atributos e estoque ─────────────────────
    const { data: variations } = (await (admin as any)
      .from('product_variations')
      .select(`
        id,
        sku_variation,
        product_variation_attributes (
          variation_type_id,
          variation_value_id,
          variation_types:variation_type_id ( name, slug ),
          variation_values:variation_value_id ( value, slug )
        ),
        stock ( quantity )
      `)
      .eq('product_id', produtoId)
      .order('id', { ascending: true })) as { data: VariationRow[] | null }

    const allVariations: VariationRow[] = variations ?? []

    // ── Determinar atributos únicos ordenados (Cor antes de Tamanho) ──────────
    const typeOrder: Record<string, number> = { cor: 0, tamanho: 1 }
    const attributeTypeMap = new Map<string, string>() // slug → name

    for (const v of allVariations) {
      for (const attr of v.product_variation_attributes ?? []) {
        if (attr.variation_types?.slug && attr.variation_types?.name) {
          attributeTypeMap.set(attr.variation_types.slug, attr.variation_types.name)
        }
      }
    }

    const attributeSlugs = [...attributeTypeMap.keys()].sort(
      (a, b) => (typeOrder[a] ?? 99) - (typeOrder[b] ?? 99)
    )
    const attributeNames = attributeSlugs.map((slug) => attributeTypeMap.get(slug)!)

    // ── Construir variants para o payload da Nuvemshop ────────────────────────
    const variantInputs = allVariations.map((v) => {
      const attrBySlug = new Map<string, string>()
      for (const attr of v.product_variation_attributes ?? []) {
        const slug  = attr.variation_types?.slug
        const value = attr.variation_values?.value
        if (slug && value) attrBySlug.set(slug, value)
      }

      const attributeValues = attributeSlugs.map((slug) => attrBySlug.get(slug) ?? '')
      const stockQty         = v.stock?.[0]?.quantity ?? 0

      return {
        internalVariationId: v.id,
        price:               product.base_price,
        stock:               stockQty,
        sku:                 v.sku_variation ?? undefined,
        attributeValues,
      }
    })

    // ── Enviar para Nuvemshop ─────────────────────────────────────────────────
    const nuvemshopProduct = await createNuvemshopProductFull({
      name:           product.name,
      images:         product.photo_url ? [product.photo_url] : undefined,
      attributeNames,
      variants:       variantInputs,
    })

    const externalProductId = String(nuvemshopProduct.id)

    // ── Salvar mapping de produto ─────────────────────────────────────────────
    await mapProductToNuvemshop(product.id, externalProductId)

    // ── Salvar mapping de CADA variação ──────────────────────────────────────
    const nsVariants = nuvemshopProduct.variants ?? []
    let mappedCount  = 0

    for (let i = 0; i < variantInputs.length; i++) {
      const input     = variantInputs[i]
      const nsVariant = nsVariants[i]

      if (!nsVariant) continue

      try {
        await mapVariantToNuvemshop(
          product.id,
          input.internalVariationId,
          externalProductId,
          String(nsVariant.id)
        )
        mappedCount++
      } catch (variantErr) {
        console.error(
          `[integrations/nuvemshop/product] Erro ao salvar mapping da variação #${input.internalVariationId}`,
          variantErr
        )
      }
    }

    return NextResponse.json({
      ok:          true,
      external_id: externalProductId,
      variants_mapped: mappedCount,
    })
  } catch (err) {
    console.error('[integrations/nuvemshop/product] Erro ao enviar produto', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
