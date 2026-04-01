import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createNuvemshopProduct,
  getMappedNuvemshopProduct,
  mapProductToNuvemshop,
  mapVariantToNuvemshop,
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

    // ── Buscar produto e primeira variação ────────────────────────────────────
    const admin = createAdminClient()
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

    // Buscar a primeira variação interna (para mapear ao variant da Nuvemshop)
    const { data: firstVariation } = (await (admin as any)
      .from('product_variations')
      .select('id')
      .eq('product_id', produtoId)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()) as { data: { id: number } | null }

    // ── Enviar para Nuvemshop ──────────────────────────────────────────────────
    const nuvemshopProduct = await createNuvemshopProduct({
      name:   product.name,
      price:  product.base_price,
      images: product.photo_url ? [product.photo_url] : undefined,
    })

    const externalProductId = String(nuvemshopProduct.id)

    // ── Salvar mapping de produto ─────────────────────────────────────────────
    await mapProductToNuvemshop(product.id, externalProductId)

    // ── Salvar mapping de variação (se existir tanto lado interno quanto externo)
    const firstNsVariant = nuvemshopProduct.variants?.[0]
    if (firstVariation && firstNsVariant) {
      try {
        await mapVariantToNuvemshop(
          product.id,
          firstVariation.id,
          externalProductId,
          String(firstNsVariant.id)
        )
      } catch (variantErr) {
        // Não bloqueia o retorno — mapping de produto já foi salvo
        console.error('[integrations/nuvemshop/product] Erro ao salvar variant mapping', variantErr)
      }
    }

    return NextResponse.json({ ok: true, external_id: externalProductId })
  } catch (err) {
    console.error('[integrations/nuvemshop/product] Erro ao enviar produto', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
