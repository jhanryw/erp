export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { resolveDynamicModeloContext, loadModeloValuesForType } from '@/lib/sku/sku-modelo-dynamic'
import { NextResponse } from 'next/server'

/**
 * GET /api/produtos/modelo-options?tipo=<slug>
 *
 * Só leitura, genérico — funciona pra qualquer Tipo com o atributo Modelo
 * ativo em type_attributes, não tem nada hardcoded pra um Tipo específico.
 * Devolve só os valores vinculados a ESSE Tipo em type_attribute_values
 * (respeitando value_governance do atributo) — nunca os valores de outro
 * Tipo que compartilhe o mesmo atributo Modelo.
 *
 * governed=false pode significar duas coisas bem diferentes, distinguidas
 * por `configured`:
 *   - configured=false: este Tipo NUNCA teve type_attributes configurado
 *     pra Modelo (comum em Tipos legados já migrados pra product_types mas
 *     ainda não pra governança dinâmica — ex.: Pijama). O formulário cai
 *     pro select estático legado (SKU_MODELO); a importação CSV cai pro
 *     mesmo mapa.
 *   - configured=true: existe uma linha em type_attributes pra este Tipo,
 *     porém INATIVA — sinal explícito de que o domínio desligou o Modelo
 *     codificado pra esse Tipo de propósito (não é "ainda não migrado").
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
    // Sem governança ATIVA — checa se existe alguma configuração inativa
    // (sinal explícito de "não usa Modelo"), pra distinguir de "nunca
    // configurado" (Tipo legado ainda não migrado).
    let configured = false
    const { data: productType } = await admin
      .from('product_types')
      .select('id')
      .eq('company_id', user.company_id)
      .eq('slug', tipo)
      .maybeSingle()

    if (productType) {
      const { data: modeloType } = await admin
        .from('variation_types')
        .select('id')
        .eq('slug', 'modelo')
        .maybeSingle()

      if (modeloType) {
        const { data: typeAttr } = await admin
          .from('type_attributes')
          .select('id')
          .eq('product_type_id', (productType as { id: number }).id)
          .eq('variation_type_id', (modeloType as { id: number }).id)
          .maybeSingle()
        configured = !!typeAttr
      }
    }

    return NextResponse.json({ governed: false, configured, required: false, values: [] })
  }

  const { data: typeAttr } = await admin
    .from('type_attributes')
    .select('required')
    .eq('product_type_id', context.productTypeId)
    .eq('variation_type_id', context.modeloVariationTypeId)
    .eq('active', true)
    .maybeSingle()

  // Respeita value_governance do atributo Modelo — 'type_restricted' (o
  // caso real hoje, com vários Tipos compartilhando o mesmo atributo) só
  // devolve os valores vinculados a ESTE Tipo em type_attribute_values,
  // nunca os de outro Tipo.
  const values = await loadModeloValuesForType(context, admin)

  return NextResponse.json({
    governed: true,
    configured: true,
    required: (typeAttr as { required: boolean } | null)?.required ?? false,
    tipoSkuCode: context.tipoSkuCode,
    productTypeId: context.productTypeId,
    values: values.map(v => ({ id: v.id, value: v.value, slug: v.slug, sku_code: v.skuCode })),
  })
}
