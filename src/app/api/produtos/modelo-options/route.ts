export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { resolveDynamicModeloContext, loadModeloValuesForType } from '@/lib/sku/sku-modelo-dynamic'
import { NextResponse } from 'next/server'

/**
 * GET /api/produtos/modelo-options?tipo=<slug>
 *
 * Só leitura, genérico — funciona pra qualquer Tipo com o atributo Modelo
 * ativo em type_attributes (hoje Calcinha e Sex Shop), não tem nada
 * hardcoded pra um Tipo específico. Devolve só os valores vinculados a ESSE
 * Tipo em type_attribute_values (respeitando value_governance do atributo)
 * — nunca os valores de outro Tipo que compartilhe o mesmo atributo Modelo.
 * Se o Tipo não tiver Modelo governado, retorna governed:false — o
 * formulário cai de volta pro select estático de sempre (SKU_MODELO).
 */
export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const tipo = searchParams.get('tipo')
  if (!tipo) return NextResponse.json({ error: 'tipo é obrigatório' }, { status: 400 })

  const admin = createAdminClient()
  const context = await resolveDynamicModeloContext(tipo, user.company_id, admin)

  if (!context) {
    return NextResponse.json({ governed: false, required: false, values: [] })
  }

  const { data: typeAttr } = await admin
    .from('type_attributes')
    .select('required')
    .eq('product_type_id', context.productTypeId)
    .eq('variation_type_id', context.modeloVariationTypeId)
    .eq('active', true)
    .maybeSingle()

  // Respeita value_governance do atributo Modelo — 'type_restricted' (o
  // caso real hoje, com Calcinha e Sex Shop compartilhando o mesmo
  // atributo) só devolve os valores vinculados a ESTE Tipo em
  // type_attribute_values, nunca os de outro Tipo.
  const values = await loadModeloValuesForType(context, admin)

  return NextResponse.json({
    governed: true,
    required: (typeAttr as { required: boolean } | null)?.required ?? false,
    tipoSkuCode: context.tipoSkuCode,
    productTypeId: context.productTypeId,
    values: values.map(v => ({ id: v.id, value: v.value, sku_code: v.skuCode })),
  })
}
