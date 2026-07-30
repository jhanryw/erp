// =============================================================================
// resolve-taxonomy.ts — resolução central de Tipo/Modelo a partir de texto
// livre (CSV, ou qualquer fonte textual), decidindo entre o PIM dinâmico
// (product_types + type_attributes + variation_values + type_attribute_values)
// e o mapa estático legado (SKU_TIPO/SKU_MODELO).
//
// Função pura — nenhum acesso a banco aqui. Quem chama já buscou os
// candidatos (productTypes, modeloGovernanceByTipoSlug,
// modeloExplicitlyNotUsedTipoSlugs), seja via admin client (server: import,
// validação) seja via fetch (client: pré-validação do CSV). Isso garante que
// pré-validação e importação definitiva nunca divirjam — chamam exatamente a
// mesma função com os mesmos dados.
//
// DECISÃO dynamic vs legacy — a existência de uma linha em product_types NÃO
// é, sozinha, sinal de fluxo dinâmico (praticamente todo Tipo legado já tem
// uma linha em product_types desde 202607301700_pim_seed_legacy_product_types.sql,
// e usar essa existência como gate tornaria o fallback legado inalcançável
// pra eles). O único gate para dynamic é GOVERNANÇA ATIVA do atributo Modelo
// (type_attributes ativo pra 'modelo' nesse Tipo) — mesmo critério que
// resolveDynamicModeloContext já usa no cadastro manual. Ordem de decisão:
//
//   1. Governança ativa de Modelo encontrada → dynamic (product_types.sku_code
//      + variation_values.sku_code do Modelo resolvido).
//   2. Sem governança ativa, mas o Tipo existe no mapa estático SKU_TIPO →
//      legacy (SKU_TIPO/SKU_MODELO), MESMO que o Tipo também exista em
//      product_types (esse é o caso comum hoje: Tipos legados já migrados
//      pra product_types mas ainda não pra type_attributes).
//   3. Sem governança ativa E sem entrada no mapa estático, mas o Tipo existe
//      em product_types: só aceito se o domínio declarou EXPLICITAMENTE que
//      esse Tipo não usa Modelo codificado (type_attributes existe mas está
//      INATIVO — sinal deliberado, não a mera ausência de configuração).
//      Caso contrário, erro de configuração — nunca aceito por omissão.
//   4. Tipo não encontrado em lugar nenhum → erro, com Tipos válidos listados.
// =============================================================================

import { SKU_TIPO, SKU_MODELO, normalizeKey } from './sku-map'

export interface ProductTypeCandidate {
  id: number
  slug: string
  name: string
  sku_code: string | null
}

export interface ModeloCandidate {
  id: number
  value: string
  slug: string
  sku_code: string | null
}

export interface ModeloGovernance {
  required: boolean
  values: ModeloCandidate[]
}

export interface ResolvedTipoModelo {
  /** slug canônico (dinâmico) ou chave normalizada (legado) — gravar em products.tipo */
  tipo: string
  /** texto a gravar em products.modelo (nunca vazio — products.modelo é NOT NULL) */
  modelo: string
  /** presente só no caminho dinâmico com um Modelo efetivamente escolhido */
  modeloValueId?: number
  /** presente só no caminho dinâmico — determina sku_scheme='dynamic' em quem chama */
  productTypeId?: number
  /** presente só no caminho dinâmico */
  tipoSkuCode?: string
  /** presente só no caminho dinâmico com um Modelo efetivamente escolhido */
  modeloSkuCode?: string
}

export type ResolveTipoModeloResult =
  | { ok: true; result: ResolvedTipoModelo }
  | { ok: false; error: string }

/** Encontra um product_type pelo slug OU nome, normalizado (acentos, espaços,
 * hífen, underscore — tudo colapsa pra mesma forma canônica via normalizeKey). */
export function matchProductType(input: string, candidates: ProductTypeCandidate[]): ProductTypeCandidate | null {
  const key = normalizeKey(input)
  if (!key) return null
  return candidates.find(c => normalizeKey(c.slug) === key || normalizeKey(c.name) === key) ?? null
}

/** Encontra um variation_value de Modelo pelo slug OU texto, normalizado,
 * dentro da lista já governada (filtrada por type_attribute_values) pra um Tipo. */
export function matchModeloValue(input: string, candidates: ModeloCandidate[]): ModeloCandidate | null {
  const key = normalizeKey(input)
  if (!key) return null
  return candidates.find(c => normalizeKey(c.slug) === key || normalizeKey(c.value) === key) ?? null
}

/**
 * Resolve Tipo + Modelo a partir de texto livre. Ver decisão dynamic vs
 * legacy no cabeçalho do arquivo.
 *
 * @param modeloExplicitlyNotUsedTipoSlugs slugs de Tipo com um type_attributes
 *   INATIVO pra 'modelo' (existe configuração, mas desligada de propósito) —
 *   sinal explícito de "este Tipo não usa Modelo codificado". Default vazio:
 *   na ausência desse sinal, um Tipo sem governança e sem mapa legado sempre
 *   gera erro de configuração (nunca aceito por omissão).
 */
export function resolveTipoModelo(
  tipoInput: string,
  modeloInput: string,
  productTypes: ProductTypeCandidate[],
  modeloGovernanceByTipoSlug: Record<string, ModeloGovernance>,
  modeloExplicitlyNotUsedTipoSlugs: Set<string> = new Set(),
): ResolveTipoModeloResult {
  const pt = matchProductType(tipoInput, productTypes)

  // 1. Governança ativa de Modelo — único critério para o caminho dinâmico.
  if (pt) {
    const governance = modeloGovernanceByTipoSlug[pt.slug]
    if (governance) {
      if (!modeloInput) {
        if (governance.required) {
          return { ok: false, error: `Modelo é obrigatório para o Tipo '${pt.name}' no PIM.` }
        }
        return {
          ok: true,
          result: { tipo: pt.slug, modelo: 'sem_modelo', productTypeId: pt.id, tipoSkuCode: pt.sku_code ?? undefined },
        }
      }

      const modelo = matchModeloValue(modeloInput, governance.values)
      if (!modelo) {
        const validos = governance.values.map(v => v.value).join(', ') || '(nenhum modelo cadastrado)'
        return {
          ok: false,
          error: `Modelo '${modeloInput}' não está vinculado ao Tipo '${pt.name}' no PIM. Modelos válidos: ${validos}`,
        }
      }

      if (!pt.sku_code) {
        return { ok: false, error: `Tipo '${pt.name}' existe no PIM mas não possui sku_code configurado.` }
      }

      return {
        ok: true,
        result: {
          tipo: pt.slug,
          modelo: modelo.value,
          modeloValueId: modelo.id,
          productTypeId: pt.id,
          tipoSkuCode: pt.sku_code,
          modeloSkuCode: modelo.sku_code ?? undefined,
        },
      }
    }
  }

  // 2. Sem governança ativa — tenta o mapa estático legado ANTES de decidir
  // qualquer coisa sobre product_types. Isso vale tanto se o Tipo existe em
  // product_types (comum: legado já migrado pra lá, mas não pra
  // type_attributes) quanto se não existe — o mapa estático é a fonte de
  // verdade nesse ponto, não a presença em product_types.
  const normTipo = normalizeKey(tipoInput)
  const TT = SKU_TIPO[normTipo as keyof typeof SKU_TIPO]

  if (TT) {
    if (!modeloInput) {
      return { ok: false, error: `Modelo é obrigatório para o Tipo '${tipoInput}'.` }
    }
    const modelMap = SKU_MODELO[TT]
    const normModelo = normalizeKey(modeloInput)
    if (!modelMap || !modelMap[normModelo]) {
      const validos = modelMap ? Object.keys(modelMap).join(', ') : '(nenhum modelo definido)'
      return {
        ok: false,
        error: `Modelo '${modeloInput}' não está vinculado ao Tipo '${tipoInput}' no PIM. Modelos válidos: ${validos}`,
      }
    }
    return { ok: true, result: { tipo: normTipo, modelo: normModelo } }
  }

  // 3. Sem governança ativa, sem mapa legado, mas o Tipo existe em
  // product_types: só aceito se o domínio declarou explicitamente (via
  // type_attributes inativo) que esse Tipo não usa Modelo codificado.
  if (pt) {
    if (modeloExplicitlyNotUsedTipoSlugs.has(pt.slug)) {
      if (!pt.sku_code) {
        return { ok: false, error: `Tipo '${pt.name}' existe no PIM mas não possui sku_code configurado.` }
      }
      return {
        ok: true,
        result: { tipo: pt.slug, modelo: modeloInput || 'sem_modelo', productTypeId: pt.id, tipoSkuCode: pt.sku_code },
      }
    }
    return {
      ok: false,
      error: `Tipo '${pt.name}' existe no PIM mas não tem nenhuma configuração de Modelo (nem governança dinâmica ativa, nem mapa legado). Configure type_attributes ou o mapa legado antes de importar produtos deste Tipo.`,
    }
  }

  // 4. Tipo não encontrado em lugar nenhum.
  const validos = productTypes.map(t => t.name).join(', ') || '(nenhum Tipo ativo cadastrado)'
  return {
    ok: false,
    error: `Tipo de produto '${tipoInput}' não encontrado ou inativo no PIM. Tipos válidos: ${validos}`,
  }
}
