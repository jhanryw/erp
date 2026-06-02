// =============================================================================
// sku-dynamic.ts — Resolução dinâmica de sku_code via Supabase
//
// getOrCreateColorSkuCode / getOrCreateSizeSkuCode garantem que qualquer
// cor ou tamanho novo receba automaticamente um sku_code único sem exigir
// edição manual no mapa hardcoded de sku-map.ts.
//
// Pré-requisito: migration 00_add_dynamic_sku_colors_and_sizes.sql já rodou.
// =============================================================================

import { normalizeKey } from './sku-map'

// ─── Público ──────────────────────────────────────────────────────────────────

/**
 * Atribui normalized_name e sku_code a um variation_value recém-criado.
 * Chamado imediatamente após o INSERT em /api/variacoes/valores.
 * Retorna o sku_code gerado.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assignSkuCode(id: number, variationTypeId: number, valueName: string, admin: any): Promise<string> {
  const normalized = normalizeKey(valueName)
  if (!normalized) throw new Error(`[sku-dynamic] Nome inválido: '${valueName}'`)

  // Verificar se já tem sku_code (idempotente)
  const { data: existing } = await admin
    .from('variation_values')
    .select('sku_code')
    .eq('id', id)
    .single()

  if (existing?.sku_code) return existing.sku_code as string

  const code = await generateNextSkuCode(variationTypeId, admin)

  const { error } = await admin
    .from('variation_values')
    .update({ normalized_name: normalized, sku_code: code })
    .eq('id', id)

  if (error) {
    throw new Error(`[sku-dynamic] Erro ao atribuir sku_code para '${valueName}': ${error.message}`)
  }

  return code
}

/**
 * Retorna o sku_code de 2 dígitos da cor dada.
 * Se a cor não existir em variation_values, cria com o próximo código disponível.
 * Se existir sem sku_code, atribui um código e salva.
 *
 * @throws Error com mensagem legível se o Supabase retornar erro inesperado.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOrCreateColorSkuCode(colorName: string, admin: any): Promise<string> {
  return getOrCreateSkuCode('cor', colorName, admin)
}

/**
 * Retorna o sku_code de 2 dígitos do tamanho dado.
 * Se o tamanho não existir em variation_values, cria com o próximo código disponível.
 * Se existir sem sku_code, atribui um código e salva.
 *
 * @throws Error com mensagem legível se o Supabase retornar erro inesperado.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOrCreateSizeSkuCode(sizeName: string, admin: any): Promise<string> {
  return getOrCreateSkuCode('tamanho', sizeName, admin)
}

// ─── Internos ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOrCreateSkuCode(typeName: string, valueName: string, admin: any): Promise<string> {
  const normalized = normalizeKey(valueName)
  if (!normalized) {
    throw new Error(`[sku-dynamic] Nome de ${typeName} inválido: '${valueName}'`)
  }

  // 1. Buscar o variation_type_id do tipo (cor ou tamanho)
  const { data: varType, error: typeError } = await admin
    .from('variation_types')
    .select('id')
    .ilike('name', typeName)
    .single()

  if (typeError || !varType) {
    throw new Error(
      `[sku-dynamic] Tipo de variação '${typeName}' não encontrado no banco. ` +
      `Verifique a tabela variation_types.`
    )
  }

  const typeId: number = varType.id

  // 2. Buscar registro existente por normalized_name
  const { data: existing, error: lookupError } = await admin
    .from('variation_values')
    .select('id, sku_code')
    .eq('variation_type_id', typeId)
    .eq('normalized_name', normalized)
    .maybeSingle()

  if (lookupError) {
    throw new Error(
      `[sku-dynamic] Erro ao buscar ${typeName} '${valueName}': ${lookupError.message}`
    )
  }

  // 3. Já existe e tem sku_code — caminho feliz
  if (existing?.sku_code) {
    return existing.sku_code as string
  }

  // 4. Gerar próximo código disponível
  const newCode = await generateNextSkuCode(typeId, admin)

  // 5a. Existe mas sem sku_code — apenas atualizar
  if (existing?.id) {
    const { error: updateError } = await admin
      .from('variation_values')
      .update({ sku_code: newCode })
      .eq('id', existing.id)

    if (updateError) {
      throw new Error(
        `[sku-dynamic] Erro ao atualizar sku_code de ${typeName} '${valueName}': ${updateError.message}`
      )
    }
    return newCode
  }

  // 5b. Não existe — criar novo registro com próximo código disponível
  // Tenta até 3 vezes para absorver race conditions no código gerado
  let lastInsertError: { code: string; message: string } | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = attempt === 0 ? newCode : await generateNextSkuCode(typeId, admin)
    const slug = normalized.replace(/_/g, '-')

    const { error: insertError } = await admin
      .from('variation_values')
      .insert({
        variation_type_id: typeId,
        value:             valueName.trim(),
        slug,
        normalized_name:   normalized,
        sku_code:          code,
        active:            true,
      })

    if (!insertError) return code

    lastInsertError = insertError

    // Se não é colisão de unicidade (23505), não adianta retentar
    if (insertError.code !== '23505') break
  }

  // Pode ter acontecido race condition no normalized_name — re-verificar
  const { data: raceCheck } = await admin
    .from('variation_values')
    .select('sku_code')
    .eq('variation_type_id', typeId)
    .eq('normalized_name', normalized)
    .maybeSingle()

  if (raceCheck?.sku_code) return raceCheck.sku_code as string

  throw new Error(
    `[sku-dynamic] Não foi possível criar ${typeName} '${valueName}' após 3 tentativas: ` +
    (lastInsertError?.message ?? 'erro desconhecido')
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateNextSkuCode(variationTypeId: number, admin: any): Promise<string> {
  const { data: rows, error } = await admin
    .from('variation_values')
    .select('sku_code')
    .eq('variation_type_id', variationTypeId)
    .not('sku_code', 'is', null)

  if (error) {
    throw new Error(`[sku-dynamic] Erro ao consultar sku_codes: ${error.message}`)
  }

  const maxCode = ((rows ?? []) as { sku_code: string }[]).reduce((max, row) => {
    const num = parseInt(row.sku_code, 10)
    return isNaN(num) ? max : Math.max(max, num)
  }, 0)

  const next = maxCode + 1
  if (next > 99) {
    throw new Error('[sku-dynamic] Limite de 99 códigos SKU atingido para este tipo de variação.')
  }

  return String(next).padStart(2, '0')
}
