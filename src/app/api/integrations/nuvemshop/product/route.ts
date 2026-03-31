import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProduct,
  getMappedNuvemshopProduct,
  mapProductToNuvemshop,
} from '@/lib/integrations/nuvemshop'

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
    // ── Idempotência ───────────────────────────────────────────────────────────
    const existing = await getMappedNuvemshopProduct(produtoId)
    if (existing) {
      return NextResponse.json({ ok: true, external_id: existing.external_id, skipped: true })
    }

    // ── Buscar produto ─────────────────────────────────────────────────────────
    const admin = createAdminClient()
    const { data: product, error: productError } = await admin
      .from('products')
      .select('id, name, base_price, photo_url')
      .eq('id', produtoId)
      .single() as unknown as {
        data: { id: number; name: string; base_price: number; photo_url: string | null } | null
        error: { message: string } | null
      }

    if (productError || !product) {
      return NextResponse.json({ error: 'Produto não encontrado.' }, { status: 404 })
    }

    // ── Enviar para Nuvemshop ──────────────────────────────────────────────────
    const nuvemshopProduct = await createNuvemshopProduct({
      name:   product.name,
      price:  product.base_price,
      images: product.photo_url ? [product.photo_url] : undefined,
    })

    // ── Salvar mapping ─────────────────────────────────────────────────────────
    await mapProductToNuvemshop(product.id, String(nuvemshopProduct.id))

    return NextResponse.json({ ok: true, external_id: String(nuvemshopProduct.id) })
  } catch (err) {
    console.error('[integrations/nuvemshop/product] Erro ao enviar produto', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
