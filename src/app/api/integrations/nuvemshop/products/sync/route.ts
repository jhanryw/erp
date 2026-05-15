import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProductFull,
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
  id:                           number
  sku_variation:                string | null
  product_variation_attributes: AttributeRow[]
  stock:                        { quantity: number }[]
}

type ProductRow = {
  id:         number
  name:       string
  base_price: number
  photo_url:  string | null
}

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const admin = createAdminClient()

  // Buscar todos os produtos ativos ainda não mapeados na Nuvemshop
  const { data: products, error: productsError } = (await admin
    .from('products')
    .select('id, name, base_price, photo_url')
    .eq('active', true)
    .order('id', { ascending: true })) as unknown as {
      data: ProductRow[] | null
      error: { message: string } | null
    }

  if (productsError || !products) {
    return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })
  }

  // Filtrar os que ainda não têm mapeamento
  const { data: alreadyMapped } = (await (admin as any)
    .from('produto_map')
    .select('produto_id')
    .eq('source', 'nuvemshop')
    .not('external_variant_id', 'is', null)) as {
      data: Array<{ produto_id: number }> | null
    }

  const mappedIds = new Set((alreadyMapped ?? []).map((r) => r.produto_id))
  const pending   = products.filter((p) => !mappedIds.has(p.id))

  const results: Array<{
    product_id:      number
    name:            string
    status:          'ok' | 'error' | 'no_variants'
    external_id?:    string
    variants_mapped?: number
    error?:          string
  }> = []

  for (const product of pending) {
    try {
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
        .eq('product_id', product.id)
        .eq('active', true)
        .order('id', { ascending: true })) as { data: VariationRow[] | null }

      const allVariations = variations ?? []

      if (allVariations.length === 0) {
        results.push({ product_id: product.id, name: product.name, status: 'no_variants' })
        continue
      }

      // Determinar atributos únicos ordenados (Cor antes de Tamanho)
      const typeOrder: Record<string, number> = { cor: 0, tamanho: 1 }
      const attributeTypeMap = new Map<string, string>()

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

      const variantInputs = allVariations.map((v) => {
        const attrBySlug = new Map<string, string>()
        for (const attr of v.product_variation_attributes ?? []) {
          const slug  = attr.variation_types?.slug
          const value = attr.variation_values?.value
          if (slug && value) attrBySlug.set(slug, value)
        }

        return {
          internalVariationId: v.id,
          price:               product.base_price,
          stock:               v.stock?.[0]?.quantity ?? 0,
          sku:                 v.sku_variation ?? undefined,
          attributeValues:     attributeSlugs.map((slug) => attrBySlug.get(slug) ?? ''),
        }
      })

      const nuvemshopProduct = await createNuvemshopProductFull({
        name:           product.name,
        images:         product.photo_url ? [product.photo_url] : undefined,
        attributeNames,
        variants:       variantInputs,
        published:      false,
      })

      const externalProductId = String(nuvemshopProduct.id)
      await mapProductToNuvemshop(product.id, externalProductId)

      const nsVariants   = nuvemshopProduct.variants ?? []
      let mappedCount    = 0

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
        } catch (err) {
          console.error(`[bulk-sync] Erro ao mapear variação #${input.internalVariationId}`, err)
        }
      }

      results.push({
        product_id:      product.id,
        name:            product.name,
        status:          'ok',
        external_id:     externalProductId,
        variants_mapped: mappedCount,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[bulk-sync] Erro no produto #${product.id}`, msg)
      results.push({ product_id: product.id, name: product.name, status: 'error', error: msg })
    }

    // Respeita o rate limit da API Nuvemshop
    await sleep(DELAY_MS)
  }

  const ok    = results.filter((r) => r.status === 'ok').length
  const error = results.filter((r) => r.status === 'error').length
  const skip  = results.filter((r) => r.status === 'no_variants').length

  return NextResponse.json({
    total_pending: pending.length,
    synced:        ok,
    errors:        error,
    no_variants:   skip,
    results,
  })
}
