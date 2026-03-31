import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProduct,
  getMappedNuvemshopProduct,
  mapProductToNuvemshop,
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

        // Salvar mapping
        await mapProductToNuvemshop(product.id, String(nuvemshopProduct.id))
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
