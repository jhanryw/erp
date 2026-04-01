import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProduct,
  getMappedNuvemshopProduct,
  mapProductToNuvemshop,
  mapVariantToNuvemshop,
} from '@/lib/integrations/nuvemshop'

type ProductRow = {
  id: number
  name: string
  base_price: number
  photo_url: string | null
}

export async function POST(_request: Request) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  try {
    const admin = createAdminClient()

    // Buscar apenas produtos ativos
    const { data: products, error } = await admin
      .from('products')
      .select('id, name, base_price, photo_url')
      .eq('active', true) as unknown as {
        data: ProductRow[] | null
        error: { message: string } | null
      }

    if (error || !products) {
      console.error('[integrations/nuvemshop/bulk] Erro ao buscar produtos', error?.message)
      return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
    }

    const total   = products.length
    let enviados  = 0
    let pulados   = 0
    const erros: { id: number; name: string; error: string }[] = []

    for (const product of products) {
      try {
        // Pular se já mapeado
        const existing = await getMappedNuvemshopProduct(product.id)
        if (existing) {
          pulados++
          continue
        }

        // Enviar
        const nuvemshopProduct = await createNuvemshopProduct({
          name:   product.name,
          price:  product.base_price,
          images: product.photo_url ? [product.photo_url] : undefined,
        })

        const externalProductId = String(nuvemshopProduct.id)

        // Salvar mapping de produto
        await mapProductToNuvemshop(product.id, externalProductId)

        // Salvar mapping de variação (primeira variação interna ↔ primeiro variant externo)
        const firstNsVariant = nuvemshopProduct.variants?.[0]
        if (firstNsVariant) {
          const { data: firstVariation } = (await (admin as any)
            .from('product_variations')
            .select('id')
            .eq('product_id', product.id)
            .order('id', { ascending: true })
            .limit(1)
            .maybeSingle()) as { data: { id: number } | null }

          if (firstVariation) {
            try {
              await mapVariantToNuvemshop(
                product.id,
                firstVariation.id,
                externalProductId,
                String(firstNsVariant.id)
              )
            } catch (variantErr) {
              console.error(`[integrations/nuvemshop/bulk] Erro ao salvar variant mapping #${product.id}`, variantErr)
            }
          }
        }

        enviados++
      } catch (err) {
        console.error(`[integrations/nuvemshop/bulk] Erro no produto #${product.id}`, err)
        erros.push({
          id:    product.id,
          name:  product.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return NextResponse.json({ total, enviados, pulados, erros })
  } catch (err) {
    console.error('[integrations/nuvemshop/bulk] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
