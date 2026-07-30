// =============================================================================
// sku-modelo-dynamic.ts — Resolução do atributo Modelo (produto-pai) e
// montagem do SKU pelo caminho dinâmico (sku_scheme='dynamic').
//
// Escopo mínimo (Fase G acelerada, só Calcinha): não generaliza pra outros
// atributos além de Modelo, não toca em nada do caminho legado
// (sku_scheme='legacy' continua usando generateParentSKU/generateSKUFromCodes
// de sku-map.ts, intocados).
//
// Resolução é por slug de Tipo (o mesmo texto que já vem do select de Tipo
// hoje) + company_id — não por categoria. categories.product_type_id ainda
// não foi backfillado para nenhuma categoria existente (nem Calcinha), então
// chavear por category_id exigiria criar categorias novas fora do escopo
// aprovado. Chavear por Tipo evita essa dependência por completo.
// =============================================================================

import { SKU_ANO } from './sku-map'
import type { ProductTypeCandidate, ModeloGovernance } from './resolve-taxonomy'

export interface DynamicModeloContext {
  productTypeId: number
  tipoSkuCode: string
  modeloVariationTypeId: number
  /**
   * unrestricted: qualquer valor ativo do atributo serve (nunca é o caso de
   * Modelo, mas é o valor de Cor/Tamanho hoje). type_restricted: só valores
   * com vínculo ativo em type_attribute_values pra este Tipo.
   * category_restricted: tratado como type_restricted nesta camada —
   * category_attribute_values ainda não existe (nenhum atributo precisou de
   * refinamento mais fino que Tipo até agora).
   */
  valueGovernance: 'unrestricted' | 'type_restricted' | 'category_restricted'
}

/**
 * Resolve o contexto necessário pra gerar SKU dinâmico a partir do slug de
 * Tipo já selecionado no formulário (ex.: 'calcinha') + company_id da
 * sessão. Confirma que esse Tipo tem o atributo Modelo governado em
 * type_attributes (ativo). Retorna null se qualquer peça faltar — sinal
 * pro chamador cair no caminho legado.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveDynamicModeloContext(tipoSlug: string, companyId: number, admin: any): Promise<DynamicModeloContext | null> {
  const { data: productType } = await admin
    .from('product_types')
    .select('id, sku_code')
    .eq('company_id', companyId)
    .eq('slug', tipoSlug)
    .maybeSingle()

  if (!productType?.sku_code) return null

  const { data: modeloType } = await admin
    .from('variation_types')
    .select('id, value_governance')
    .eq('slug', 'modelo')
    .maybeSingle()

  if (!modeloType) return null

  const { data: typeAttr } = await admin
    .from('type_attributes')
    .select('id')
    .eq('product_type_id', productType.id)
    .eq('variation_type_id', modeloType.id)
    .eq('active', true)
    .maybeSingle()

  if (!typeAttr) return null

  return {
    productTypeId: productType.id,
    tipoSkuCode: productType.sku_code,
    modeloVariationTypeId: modeloType.id,
    valueGovernance: modeloType.value_governance ?? 'unrestricted',
  }
}

export interface ModeloValue {
  id: number
  value: string
  slug: string
  skuCode: string
}

/**
 * Lista os valores de Modelo válidos para o Tipo do contexto, respeitando
 * value_governance: 'unrestricted' devolve todos os valores ativos do
 * atributo (comportamento antigo, hoje só usado se alguém reverter a
 * governança manualmente); 'type_restricted'/'category_restricted' devolve
 * só os valores com vínculo ativo em type_attribute_values pra este Tipo —
 * é isso que impede o Modelo de Calcinha aparecer pra Sex Shop e vice-versa.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadModeloValuesForType(context: DynamicModeloContext, admin: any): Promise<ModeloValue[]> {
  if (context.valueGovernance === 'unrestricted') {
    const { data } = await admin
      .from('variation_values')
      .select('id, value, slug, sku_code')
      .eq('variation_type_id', context.modeloVariationTypeId)
      .eq('active', true)
      .order('value')

    return ((data ?? []) as { id: number; value: string; slug: string; sku_code: string | null }[])
      .filter(v => v.sku_code)
      .map(v => ({ id: v.id, value: v.value, slug: v.slug, skuCode: v.sku_code as string }))
  }

  const { data } = await admin
    .from('type_attribute_values')
    .select('variation_values!inner(id, value, slug, sku_code, active)')
    .eq('product_type_id', context.productTypeId)
    .eq('active', true)
    .eq('variation_values.active', true)

  return ((data ?? []) as { variation_values: { id: number; value: string; slug: string; sku_code: string | null } }[])
    .map(row => row.variation_values)
    .filter(v => v && v.sku_code)
    .map(v => ({ id: v.id, value: v.value, slug: v.slug, skuCode: v.sku_code as string }))
    .sort((a, b) => a.value.localeCompare(b.value))
}

/**
 * Carrega um valor de Modelo e confirma que: pertence ao variation_type
 * "Modelo" esperado, está ativo, e — quando value_governance exige —
 * está de fato vinculado ao Tipo do contexto em type_attribute_values.
 * Sem essa última checagem, um cliente poderia enviar o Modelo de um Tipo
 * diferente do que está sendo cadastrado (ex.: "Golfinho" de Sex Shop numa
 * Calcinha) e o servidor aceitaria — a validação de variation_type_id
 * sozinha não pega isso, já que os dois Tipos compartilham o mesmo atributo.
 * Retorna null se inválido — o chamador deve tratar como erro de validação
 * (422), nunca cair silenciosamente pro caminho legado neste caso.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadModeloValue(modeloValueId: number, context: DynamicModeloContext, admin: any): Promise<ModeloValue | null> {
  const { data } = await admin
    .from('variation_values')
    .select('id, value, slug, sku_code, variation_type_id, active')
    .eq('id', modeloValueId)
    .maybeSingle()

  if (!data || !data.active || data.variation_type_id !== context.modeloVariationTypeId || !data.sku_code) return null

  if (context.valueGovernance !== 'unrestricted') {
    const { data: link } = await admin
      .from('type_attribute_values')
      .select('id')
      .eq('product_type_id', context.productTypeId)
      .eq('variation_value_id', modeloValueId)
      .eq('active', true)
      .maybeSingle()

    if (!link) return null
  }

  return { id: data.id as number, value: data.value as string, slug: data.slug as string, skuCode: data.sku_code as string }
}

/**
 * Monta o SKU de 10 dígitos (TTMMCCTTAA) a partir de códigos já resolvidos
 * — nenhum lookup em mapa estático. Mesma forma final de
 * generateSKUFromCodes() (sku-map.ts), só que a origem de TT/MM é dinâmica
 * em vez de SKU_TIPO/SKU_MODELO. modeloSkuCode é opcional — Tipos onde
 * Modelo não é obrigatório (Sex Shop) podem não ter um Modelo escolhido;
 * nesse caso MM vira '00', igual à convenção já usada para Cor/Tamanho
 * ausentes. Nunca um código inventado — '00' significa literalmente
 * "não se aplica".
 */
export function buildDynamicSkuBase(params: {
  tipoSkuCode:    string
  modeloSkuCode?: string
  corCode?:       string
  tamanhoCode?:   string
  ano:            string
}): string {
  const AA = SKU_ANO[String(params.ano).trim()]
  if (!AA) {
    const anosValidos = Object.keys(SKU_ANO).filter(k => k.length === 4).join(', ')
    throw new Error(`Ano '${params.ano}' não suportado no mapa oficial. Anos válidos: ${anosValidos}`)
  }

  const MM = params.modeloSkuCode ?? '00'
  const CC = params.corCode       ?? '00'
  const TS = params.tamanhoCode   ?? '00'

  const sku = `${params.tipoSkuCode}${MM}${CC}${TS}${AA}`
  if (sku.length !== 10) {
    throw new Error(`Falha interna na geração dinâmica do SKU: comprimento incorreto (${sku.length}). Gerado: '${sku}'`)
  }
  return sku
}

/**
 * Lista os product_types ativos de uma empresa — fonte única usada pelo
 * select de Tipo (produtos/novo), pelo endpoint /api/produtos/tipos e pela
 * resolução de Tipo na importação CSV (resolveTipoModelo, em
 * resolve-taxonomy.ts). Nenhuma consulta duplicada em cada consumidor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listActiveProductTypes(companyId: number, admin: any): Promise<ProductTypeCandidate[]> {
  const { data } = await admin
    .from('product_types')
    .select('id, name, slug, sku_code')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('name')

  return (data ?? []) as ProductTypeCandidate[]
}

export interface ModeloGovernanceLookup {
  /** Governança ativa por slug de Tipo — único critério para o caminho
   * dinâmico em resolveTipoModelo. */
  governanceByTipoSlug: Record<string, ModeloGovernance>
  /** Slugs de Tipo com um type_attributes existente pra 'modelo' porém
   * INATIVO — sinal explícito de "este Tipo não usa Modelo codificado"
   * (diferente de "nunca configurado", que deve gerar erro em
   * resolveTipoModelo, não aceitar por omissão). */
  explicitlyNotUsedTipoSlugs: Set<string>
}

/**
 * Calcula, para cada product_type ativo, a governança de Modelo (ativa ou
 * explicitamente desligada) — reaproveita resolveDynamicModeloContext +
 * loadModeloValuesForType (nenhuma regra de governança nova). Usado pela
 * importação CSV para resolver todas as linhas de uma vez, sem duplicar a
 * lógica que já governa o cadastro manual e o endpoint
 * /api/produtos/modelo-options.
 *
 * Importante: a existência de uma linha em product_types NÃO implica
 * governança — praticamente todo Tipo legado já tem linha em product_types
 * (202607301700_pim_seed_legacy_product_types.sql) sem nunca ter ganhado
 * type_attributes pra Modelo. Por isso a checagem de "existe configuração"
 * é feita direto em type_attributes (sem eq('active', true)), não via
 * resolveDynamicModeloContext sozinho (que só enxerga o caso ativo).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadModeloGovernanceForAllTypes(
  productTypes: ProductTypeCandidate[],
  companyId: number,
  admin: any,
): Promise<ModeloGovernanceLookup> {
  const governanceByTipoSlug: Record<string, ModeloGovernance> = {}
  const explicitlyNotUsedTipoSlugs = new Set<string>()

  const { data: modeloTypeRow } = await admin
    .from('variation_types')
    .select('id')
    .eq('slug', 'modelo')
    .maybeSingle()
  const modeloVariationTypeId = (modeloTypeRow as { id: number } | null)?.id
  if (!modeloVariationTypeId) return { governanceByTipoSlug, explicitlyNotUsedTipoSlugs }

  for (const pt of productTypes) {
    const { data: typeAttr } = await admin
      .from('type_attributes')
      .select('required, active')
      .eq('product_type_id', pt.id)
      .eq('variation_type_id', modeloVariationTypeId)
      .maybeSingle()

    const attr = typeAttr as { required: boolean; active: boolean } | null
    if (!attr) continue // nunca configurado — resolveTipoModelo decide (legado ou erro)

    if (!attr.active) {
      explicitlyNotUsedTipoSlugs.add(pt.slug)
      continue
    }

    const context = await resolveDynamicModeloContext(pt.slug, companyId, admin)
    if (!context) continue
    const values = await loadModeloValuesForType(context, admin)

    governanceByTipoSlug[pt.slug] = {
      required: !!attr.required,
      values: values.map(v => ({ id: v.id, value: v.value, slug: v.slug, sku_code: v.skuCode })),
    }
  }

  return { governanceByTipoSlug, explicitlyNotUsedTipoSlugs }
}
