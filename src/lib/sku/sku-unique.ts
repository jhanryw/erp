/**
 * sku-unique.ts — Geração de sku_variation globalmente único
 *
 * Padrão de sufixo:
 *   Primeira ocorrência  → baseSku              (ex: 1402020125)
 *   Segunda ocorrência   → baseSku + '02'       (ex: 140202012502)
 *   Terceira             → baseSku + '03'       (ex: 140202012503)
 *   …até                 → baseSku + '99'
 *
 * A query usa LIKE 'baseSku%' sobre o índice UNIQUE de sku_variation —
 * sem full-scan, sem lock explícito. Race conditions residuais são tratadas
 * por retry no chamador (ver insertVariationWithRetry).
 */

// ─── Geração de SKU único ─────────────────────────────────────────────────────

/**
 * Retorna o primeiro sku_variation disponível globalmente para o baseSku dado.
 *
 * @param baseSku  SKU de 10 dígitos gerado por generateSKU()
 * @param admin    Supabase admin client (service_role)
 *
 * @example
 * // banco contém: 1402020125, 140202012502, 140202012503
 * await generateUniqueSkuVariation('1402020125', admin)
 * // → '140202012504'
 */
export async function generateUniqueSkuVariation(
  baseSku: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
): Promise<string> {
  // LIKE 'baseSku%' usa o índice btree do UNIQUE constraint — eficiente.
  const { data: rows, error } = await admin
    .from('product_variations')
    .select('sku_variation')
    .like('sku_variation', `${baseSku}%`)

  if (error) {
    throw new Error(`[sku-unique] Erro ao consultar SKUs existentes: ${error.message}`)
  }

  // Conjunto de todos os SKUs que começam com baseSku
  const existing = new Set<string>(
    (rows ?? []).map((r: { sku_variation: string }) => r.sku_variation),
  )

  // Caso feliz: baseSku ainda não existe — retorna direto
  if (!existing.has(baseSku)) return baseSku

  // Baseku está ocupado — procurar o menor sufixo livre (02 → 99)
  for (let i = 2; i <= 99; i++) {
    const candidate = baseSku + String(i).padStart(2, '0')
    if (!existing.has(candidate)) return candidate
  }

  // Situação extremamente improvável (>98 produtos com mesmo baseSku)
  throw new Error(
    `[sku-unique] Não foi possível alocar SKU único para base "${baseSku}": ` +
    `todos os sufixos 02–99 estão em uso.`,
  )
}

// ─── Tipos de resultado ───────────────────────────────────────────────────────

export interface VariationInsertPayload {
  product_id:    number
  sku_variation: string       // preenchido internamente — não usar o campo do caller
  cost_override:  number | null
  price_override: number | null
  active:         boolean
}

export interface VariationInsertResult {
  ok:     true
  pv:     { id: number }
  varSku: string
}
export interface VariationInsertError {
  ok:      false
  message: string
  /** true se o erro NÃO é 23505 (erros estruturais que não devem ser retentados) */
  fatal:   boolean
}

// ─── Insert com desvio automático + retry de race condition ──────────────────

/**
 * Insere uma variação em product_variations usando o primeiro sku_variation
 * disponível a partir de baseSku, com até `maxAttempts` tentativas para absorver
 * race conditions (dois requests simultâneos que passam pela mesma janela de check).
 *
 * @param baseSku       SKU de 10 dígitos gerado por generateSKU()
 * @param payload       Campos da variação sem sku_variation (preenchido aqui)
 * @param admin         Supabase admin client
 * @param maxAttempts   Máximo de tentativas em caso de 23505 (padrão: 3)
 */
export async function insertVariationWithRetry(
  baseSku: string,
  payload: Omit<VariationInsertPayload, 'sku_variation'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  maxAttempts = 3,
): Promise<VariationInsertResult | VariationInsertError> {
  let varSku = baseSku
  let lastError: { code: string; message: string } | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Cada tentativa re-consulta o banco para refletir escritas concorrentes
    varSku = await generateUniqueSkuVariation(baseSku, admin)

    const { data: pv, error } = (await admin
      .from('product_variations')
      .insert({ ...payload, sku_variation: varSku })
      .select('id')
      .single()) as unknown as {
        data: { id: number } | null
        error: { code: string; message: string } | null
      }

    if (!error && pv) {
      return { ok: true, pv, varSku }
    }

    lastError = error

    // Erro que não é conflito de unicidade → não adianta retentar
    if (error?.code !== '23505') {
      return {
        ok:      false,
        message: error?.message ?? 'Erro desconhecido ao inserir variação.',
        fatal:   true,
      }
    }

    // 23505 por race condition → loga e tenta novamente
    console.warn(
      `[sku-unique] Race condition em sku_variation "${varSku}" ` +
      `(tentativa ${attempt + 1}/${maxAttempts}). Retentando…`,
    )
  }

  return {
    ok:      false,
    message: `Não foi possível inserir variação após ${maxAttempts} tentativas ` +
             `(base: "${baseSku}"). Tente novamente.`,
    fatal:   false,
  }
}
