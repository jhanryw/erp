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
