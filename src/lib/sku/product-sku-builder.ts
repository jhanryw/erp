// =============================================================================
// product-sku-builder.ts — fonte única para gerar o SKU de variação de um
// produto JÁ EXISTENTE (edição / adição de variações).
//
// Cada produto carrega o esquema com que nasceu (products.sku_scheme):
//   - 'legacy'  → SKU_TIPO/SKU_MODELO (sku-map.ts)
//   - 'dynamic' → product_types.sku_code + variation_values.sku_code do Modelo
//                 (sku-modelo-dynamic.ts), governado por type_attribute_values
//
// Antes, o PUT /api/produtos/[id] sempre usava o mapa legado, então um produto
// dinâmico (ex.: Cinta/"Short", cujo Modelo só existe no PIM) era rejeitado.
// O POST já respeitava o esquema; este helper faz a edição seguir a mesma regra.
// Nunca recalcula nem altera SKUs já emitidos.
// =============================================================================

import { generateSKUFromCodes, normalizeKey } from './sku-map'
import { resolveDynamicModeloContext, loadModeloValuesForType, buildDynamicSkuBase } from './sku-modelo-dynamic'

export interface ProductSkuMeta {
  tipo:        string
  modelo:      string
  ano:         string
  sku_scheme?: string | null
}

export interface VariationSkuCodes {
  corCode?:     string
  tamanhoCode?: string
}

/** Resolve (uma vez por produto) e devolve o gerador de SKU base por cor/tamanho. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createProductSkuBuilder(meta: ProductSkuMeta, companyId: number, admin: any): Promise<(codes: VariationSkuCodes) => string> {
  if (meta.sku_scheme !== 'dynamic') {
    return ({ corCode, tamanhoCode }) =>
      generateSKUFromCodes({ tipo: meta.tipo, modelo: meta.modelo, corCode, tamanhoCode, ano: meta.ano })
  }

  const context = await resolveDynamicModeloContext(meta.tipo, companyId, admin)
  if (!context) {
    throw new Error(`Tipo '${meta.tipo}' não tem mais o atributo Modelo ativo no PIM; não é possível gerar SKU deste produto.`)
  }

  let modeloSkuCode: string | undefined
  if (meta.modelo !== 'sem_modelo') {
    const values = await loadModeloValuesForType(context, admin)
    const key = normalizeKey(meta.modelo)
    const match = values.find(v => normalizeKey(v.value) === key || normalizeKey(v.slug) === key)
    if (!match) {
      throw new Error(`Modelo '${meta.modelo}' não está vinculado ao Tipo '${meta.tipo}' no PIM. Modelos válidos: ${values.map(v => v.value).join(', ') || '(nenhum)'}`)
    }
    modeloSkuCode = match.skuCode
  }

  return ({ corCode, tamanhoCode }) =>
    buildDynamicSkuBase({ tipoSkuCode: context.tipoSkuCode, modeloSkuCode, corCode, tamanhoCode, ano: meta.ano })
}

/**
 * Sufixo de identidade do produto (product_sku_identities.discriminator).
 * A importação/RPC (_build_variant_sku) embute o discriminador (2 dígitos,
 * omitido quando <= 1) no fim do SKU de cada variante, o que distingue
 * produtos que compartilham o mesmo SKU-base. A edição precisa seguir a
 * mesma convenção, senão a variante nova nasce "sem dono" (ou ganha um
 * sufixo de colisão arbitrário que pode coincidir com o de outro produto).
 *
 * Seguro por construção — só embute quando o produto já está na convenção:
 *   - sem sku_identity_id, ou discriminador <= 1  → '' (comportamento antigo)
 *   - com variantes: só embute se alguma variante existente de 12 dígitos
 *     já termina com o discriminador (produtos da era pré-RPC têm variantes
 *     sem ele e continuam como estão);
 *   - sem variantes: embute (produto da era RPC).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveVariantIdentitySuffix(product: { id: number; sku_identity_id?: number | null }, admin: any): Promise<string> {
  if (!product.sku_identity_id) return ''
  const { data: identity } = await admin
    .from('product_sku_identities')
    .select('discriminator')
    .eq('id', product.sku_identity_id)
    .maybeSingle()
  const d = Number(identity?.discriminator)
  if (!Number.isFinite(d) || d <= 1) return ''
  const suffix = String(d).padStart(2, '0')

  const { data: variations } = await admin
    .from('product_variations')
    .select('sku_variation')
    .eq('product_id', product.id)
  const skus = ((variations ?? []) as { sku_variation: string }[]).map(v => v.sku_variation)
  if (skus.length === 0) return suffix
  return skus.some(s => s.length === 12 && s.endsWith(suffix)) ? suffix : ''
}
