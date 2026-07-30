export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ncmFieldSchema, cestFieldSchema, origemFieldSchema } from '@/lib/validators'

import { generateParentSKU, generateSKUFromCodes } from '@/lib/sku/sku-map'
import { getOrCreateColorSkuCode, getOrCreateSizeSkuCode } from '@/lib/sku/sku-dynamic'
import { insertVariationWithRetry } from '@/lib/sku/sku-unique'
import { resolveDynamicModeloContext, loadModeloValue, buildDynamicSkuBase } from '@/lib/sku/sku-modelo-dynamic'
import { initializeStock } from '@/services/estoque.service'

const variantSchema = z.object({
  color_value_id: z.number().int().positive().nullable().optional(),
  size_value_id: z.number().int().positive().nullable().optional(),
  price_override: z.coerce.number().positive().nullable().optional(),
  cost_override: z.coerce.number().min(0).nullable().optional(),
  initial_stock: z.coerce.number().int().min(0).default(0),
})

// modelo_value_id (opcional): quando presente, ativa o caminho dinâmico de
// SKU (Fase G acelerada — hoje só Calcinha tem Modelo governado em
// type_attributes). "tipo" continua sempre obrigatório (mesmo select de
// sempre) — é usado tanto pro caminho legado quanto pra resolver o Tipo no
// caminho dinâmico. Só "modelo" (texto livre) vira opcional quando
// modelo_value_id está presente — o servidor deriva o texto a partir do
// valor de Modelo escolhido, nunca aceita os dois desacoplados (é esse
// descolamento que causou o bug de categorização original).
const schema = z.object({
  name: z.string().min(2),
  tipo: z.string().min(1),
  modelo: z.string().min(1).optional(),
  modelo_value_id: z.coerce.number().int().positive().optional(),
  ano: z.string().min(1),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  brand_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0),
  base_price: z.coerce.number().positive(),
  active: z.boolean().default(true),
  variants: z.array(variantSchema).optional(),
  ncm: ncmFieldSchema(),
  cest: cestFieldSchema(),
  origem: origemFieldSchema(),
  unidade_med: z.string().max(10).default('UN').optional(),
}).superRefine((data, ctx) => {
  if (!data.modelo_value_id && !data.modelo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelo'], message: 'Modelo é obrigatório.' })
  }
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { variants, modelo_value_id, ...productData } = parsed.data

  // Caminho dinâmico de SKU: ativa pra qualquer Tipo com Modelo governado em
  // type_attributes (hoje Calcinha e Sex Shop) — resolvido pelo slug de Tipo
  // já selecionado (mesmo campo "tipo" de sempre) + company_id, não por
  // categoria (categories.product_type_id ainda não foi backfillado pra toda
  // categoria existente). Sempre resolve o contexto, mesmo sem
  // modelo_value_id — um Tipo dinâmico com Modelo opcional (Sex Shop) pode
  // legitimamente não ter um Modelo escolhido; nesse caso MM vira '00' e o
  // texto legado grava um marcador explícito ('sem_modelo'), nunca aceito
  // como texto livre do cliente.
  const resolvedTipo = productData.tipo
  let resolvedModelo = productData.modelo
  let skuScheme: 'legacy' | 'dynamic' = 'legacy'
  let dynamicTipoSkuCode: string | null = null
  let dynamicModeloVariationTypeId: number | null = null
  let dynamicModeloValueId: number | null = null
  let dynamicModeloSkuCode: string | undefined = undefined

  const dynamicContext = await resolveDynamicModeloContext(resolvedTipo, user.company_id, admin)

  if (dynamicContext) {
    skuScheme = 'dynamic'
    dynamicTipoSkuCode = dynamicContext.tipoSkuCode
    dynamicModeloVariationTypeId = dynamicContext.modeloVariationTypeId

    if (modelo_value_id) {
      const modeloValue = await loadModeloValue(modelo_value_id, dynamicContext, admin)
      if (!modeloValue) {
        return NextResponse.json({ error: 'Modelo inválido para este Tipo.' }, { status: 422 })
      }
      resolvedModelo = modeloValue.value
      dynamicModeloValueId = modeloValue.id
      dynamicModeloSkuCode = modeloValue.skuCode
    } else {
      // Modelo é opcional para este Tipo (ex.: Sex Shop) — sem escolha,
      // MM vira '00' e o texto legado grava um marcador explícito, nunca
      // vazio silencioso (products.modelo é NOT NULL).
      resolvedModelo = 'sem_modelo'
    }
  } else if (!resolvedModelo) {
    // Caminho legado (Tipo sem Modelo dinâmico) — modelo texto continua
    // obrigatório, como sempre foi.
    return NextResponse.json({ error: 'Modelo é obrigatório.' }, { status: 422 })
  }

  // Verificar duplicata antes de inserir — retorna 409 com id do existente
  const { data: existingProduct } = (await admin
    .from('products')
    .select('id, name')
    .eq('company_id', user.company_id)
    .ilike('name', productData.name.trim())
    .eq('tipo', resolvedTipo)
    .eq('modelo', resolvedModelo)
    .eq('ano', productData.ano)
    .maybeSingle()) as unknown as { data: { id: number; name: string } | null }

  if (existingProduct) {
    return NextResponse.json(
      {
        error: `Produto "${existingProduct.name}" com este tipo, modelo e ano já existe. Deseja adicionar variações a ele?`,
        existingId: existingProduct.id,
      },
      { status: 409 }
    )
  }

  const parentSku = skuScheme === 'dynamic'
    ? buildDynamicSkuBase({ tipoSkuCode: dynamicTipoSkuCode!, modeloSkuCode: dynamicModeloSkuCode, ano: productData.ano })
    : generateParentSKU(resolvedTipo, resolvedModelo, productData.ano)

  const { data: product, error: productError } = (await (admin as any)
    .from('products')
    .insert({
      ...productData,
      tipo: resolvedTipo,
      modelo: resolvedModelo,
      sku: parentSku,
      sku_scheme: skuScheme,
      supplier_id: productData.supplier_id ?? null,
      brand_id: productData.brand_id ?? null,
      subcategory_id: null,
      collection_id: null,
      company_id: user.company_id,
    })
    .select('id')
    .single()) as unknown as { data: { id: number } | null; error: { code: string; message: string } | null }

  if (productError) {
    const msg =
      productError.code === '23503'
        ? 'Categoria ou fornecedor inválido.'
        : productError.message

    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // Grava o atributo Modelo do produto-pai (product_attribute_values) —
  // só no caminho dinâmico. Falha aqui não deveria acontecer (mesma
  // transação lógica da criação do produto), mas se acontecer o produto já
  // foi criado sem o vínculo; log de erro em vez de rollback, já que o
  // produto em si é válido e o vínculo pode ser corrigido manualmente.
  if (skuScheme === 'dynamic' && product && dynamicModeloVariationTypeId && dynamicModeloValueId) {
    const { error: pavError } = await (admin as any).from('product_attribute_values').insert({
      product_id: product.id,
      variation_type_id: dynamicModeloVariationTypeId,
      variation_value_id: dynamicModeloValueId,
    })
    if (pavError) {
      console.error('[POST /api/produtos] Falha ao gravar product_attribute_values (Modelo)', pavError)
    }
  }

  // 2. Criar variantes (se houver)
  // Wrapped em try/catch: qualquer falha aqui (generateSKU, pvError, stockInit)
  // faz o produto recém-criado ser removido para evitar estado parcial no banco.
  if (variants && variants.length > 0 && product) {
    try {
      for (const v of variants) {
        // 2b/a. Buscar atributos para compor o SKU e associar (cor e tamanho)
        const attrs: any[] = []
        let colorSkuCode: string | undefined
        let sizeSkuCode:  string | undefined

        if (v.color_value_id) {
          const { data: colorType } = (await admin
            .from('variation_values')
            .select('variation_type_id, value, sku_code')
            .eq('id', v.color_value_id)
            .single()) as unknown as { data: { variation_type_id: number, value: string, sku_code: string | null } | null }

          if (colorType) {
            colorSkuCode = colorType.sku_code ?? await getOrCreateColorSkuCode(colorType.value, admin)
            attrs.push({
              variation_type_id: colorType.variation_type_id,
              variation_value_id: v.color_value_id,
            })
          }
        }

        if (v.size_value_id) {
          const { data: sizeType } = (await admin
            .from('variation_values')
            .select('variation_type_id, value, sku_code')
            .eq('id', v.size_value_id)
            .single()) as unknown as { data: { variation_type_id: number, value: string, sku_code: string | null } | null }

          if (sizeType) {
            sizeSkuCode = sizeType.sku_code ?? await getOrCreateSizeSkuCode(sizeType.value, admin)
            attrs.push({
              variation_type_id: sizeType.variation_type_id,
              variation_value_id: v.size_value_id,
            })
          }
        }

        const baseSku = skuScheme === 'dynamic'
          ? buildDynamicSkuBase({
              tipoSkuCode:   dynamicTipoSkuCode!,
              modeloSkuCode: dynamicModeloSkuCode,
              corCode:       colorSkuCode,
              tamanhoCode:   sizeSkuCode,
              ano:           productData.ano,
            })
          : generateSKUFromCodes({
              tipo:         resolvedTipo,
              modelo:       resolvedModelo,
              corCode:      colorSkuCode,
              tamanhoCode:  sizeSkuCode,
              ano:          productData.ano,
            })

        // Insere com desvio automático de sufixo + retry por race condition
        const insertResult = await insertVariationWithRetry(
          baseSku,
          {
            product_id:    product.id,
            cost_override: v.cost_override ?? null,
            price_override: v.price_override ?? null,
            active: true,
          },
          admin,
        )

        if (!insertResult.ok) {
          throw new Error(`Erro ao criar variante (base ${baseSku}): ${insertResult.message}`)
        }

        const { pv } = insertResult

        if (attrs.length > 0) {
          const finalAttrs = attrs.map(a => ({ ...a, product_variation_id: pv.id }))
          await admin.from('product_variation_attributes').insert(finalAttrs as any)
        }

        // 2c. Carga inicial via RPC — gera movimento 'initial' se quantity > 0,
        // sem stock_lot nem finance_entry (pré-operação). Trigger bloqueia insert direto.
        const stockInit = await initializeStock({
          product_variation_id: pv.id,
          quantity: v.initial_stock,
          avg_cost: v.cost_override ?? productData.base_cost,
        }, user.id)
        if (!stockInit.ok) {
          throw new Error(stockInit.error ?? 'Erro ao inicializar estoque da variante.')
        }
      }
    } catch (variantErr) {
      // Rollback: remover o produto recém-criado para não deixar estado parcial.
      // A FK em product_variations cascateia para variantes e stock já criados.
      await (admin as any).from('products').delete().eq('id', product.id)
      console.error('[POST /api/produtos] Rollback executado — produto removido por falha nas variantes', variantErr)
      const msg = variantErr instanceof Error ? variantErr.message : 'Erro ao criar variantes do produto.'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  auditLog({ userId: user.id, userRole: user.role, action: 'create', resource: 'product', resourceId: product?.id, detail: parentSku })
  return NextResponse.json({ product }, { status: 201 })
}
