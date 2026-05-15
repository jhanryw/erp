import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProductFull,
  mapProductToNuvemshop,
  mapVariantToNuvemshop,
} from '@/lib/integrations/nuvemshop'

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

export async function POST(request: Request) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: { productIds?: number[] } = {}
  try { body = await request.json() } catch { /* sem body é sync total */ }

  const admin   = createAdminClient()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch { /* cliente desconectou */ }
      }

      try {
        // 1. Buscar produtos
        let query = (admin as any)
          .from('products')
          .select('id, name, base_price, photo_url')
          .eq('active', true)
          .order('id', { ascending: true })

        if (body.productIds && body.productIds.length > 0) {
          query = query.in('id', body.productIds)
        }

        const { data: products, error: productsError } = await query as {
          data: Array<{ id: number; name: string; base_price: number; photo_url: string | null }> | null
          error: { message: string } | null
        }

        if (productsError || !products) {
          send({ type: 'error', message: 'Erro ao buscar produtos no banco.' })
          controller.close()
          return
        }

        // 2. Filtrar os que ainda não têm mapeamento de variante
        const { data: alreadyMapped } = (await (admin as any)
          .from('produto_map')
          .select('produto_id')
          .eq('source', 'nuvemshop')
          .not('external_variant_id', 'is', null)) as {
            data: Array<{ produto_id: number }> | null
          }

        const mappedIds = new Set((alreadyMapped ?? []).map((r: { produto_id: number }) => r.produto_id))
        const pending   = products.filter((p) => !mappedIds.has(p.id))

        send({ type: 'start', total: pending.length })

        if (pending.length === 0) {
          send({ type: 'done', synced: 0, errors: 0, no_variants: 0, total: 0 })
          controller.close()
          return
        }

        let synced = 0, errors = 0, noVariants = 0

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
              send({ type: 'product', status: 'no_variants', name: product.name, product_id: product.id })
              noVariants++
              await sleep(DELAY_MS)
              continue
            }

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
              } catch (err) {
                console.error(`[sync-stream] Erro ao mapear variação #${input.internalVariationId}`, err)
              }
            }

            const stockTotal = variantInputs.reduce((sum, v) => sum + v.stock, 0)
            send({
              type:            'product',
              status:          'ok',
              name:            product.name,
              product_id:      product.id,
              variants_mapped: mappedCount,
              stock_total:     stockTotal,
            })
            synced++
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[sync-stream] Erro no produto #${product.id}`, msg)
            send({ type: 'product', status: 'error', name: product.name, product_id: product.id, error: msg })
            errors++
          }

          await sleep(DELAY_MS)
        }

        send({ type: 'done', synced, errors, no_variants: noVariants, total: pending.length })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[sync-stream] Exceção não tratada', msg)
        send({ type: 'error', message: msg })
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
