/**
 * Pareamento ERP variation ↔ Nuvemshop variant por SKU (puro, sem I/O).
 *
 * O SKU enviado à Nuvemshop é `product_variations.sku_variation` (UNIQUE no
 * banco, gerado pelo PIM). Pareamento por posição no array (`nsVariants[i]`)
 * foi abandonado: a ordem de resposta não é contrato da API.
 *
 * Regra: sem SKU válido e único não há pareamento — nunca se adivinha.
 */

export function normalizeSku(sku: string | null | undefined): string | null {
  const trimmed = (sku ?? '').trim()
  return trimmed ? trimmed.toUpperCase() : null
}

export interface ErpVariationSku {
  variationId: number
  sku:         string | null
}

export interface SkuValidationIssue {
  variationId: number
  sku:         string | null
  problem:     'missing' | 'duplicate'
}

/** SKUs das variações ERP precisam existir e ser únicos dentro do produto. */
export function validateErpSkus(variations: ErpVariationSku[]): SkuValidationIssue[] {
  const issues: SkuValidationIssue[] = []
  const count = new Map<string, number>()
  for (const v of variations) {
    const key = normalizeSku(v.sku)
    if (key) count.set(key, (count.get(key) ?? 0) + 1)
  }
  for (const v of variations) {
    const key = normalizeSku(v.sku)
    if (!key) issues.push({ variationId: v.variationId, sku: v.sku, problem: 'missing' })
    else if ((count.get(key) ?? 0) > 1) issues.push({ variationId: v.variationId, sku: v.sku, problem: 'duplicate' })
  }
  return issues
}

export interface RemoteVariantSku {
  id:   number | string
  sku?: string | null
}

export interface VariantPairingResult {
  pairs:     Array<{ variationId: number; remoteVariantId: string }>
  unmatched: Array<{ variationId: number; sku: string | null; reason: 'missing_sku' | 'not_found_remote' | 'duplicate_remote_sku' | 'duplicate_erp_sku' }>
}

/**
 * Pareia por SKU normalizado. SKU remoto repetido ou SKU ERP repetido/vazio
 * NUNCA gera par. `excludeRemoteVariantIds` = variantes remotas já vinculadas.
 */
export function pairVariantsBySku(
  erp: ErpVariationSku[],
  remote: RemoteVariantSku[],
  excludeRemoteVariantIds: Iterable<string> = [],
): VariantPairingResult {
  const excluded = new Set([...excludeRemoteVariantIds].map(String))
  const remoteBySku = new Map<string, RemoteVariantSku[]>()
  for (const r of remote) {
    const key = normalizeSku(r.sku)
    if (!key) continue
    const list = remoteBySku.get(key) ?? []
    list.push(r)
    remoteBySku.set(key, list)
  }

  const erpCount = new Map<string, number>()
  for (const v of erp) {
    const key = normalizeSku(v.sku)
    if (key) erpCount.set(key, (erpCount.get(key) ?? 0) + 1)
  }

  const result: VariantPairingResult = { pairs: [], unmatched: [] }
  for (const v of erp) {
    const key = normalizeSku(v.sku)
    if (!key) { result.unmatched.push({ variationId: v.variationId, sku: v.sku, reason: 'missing_sku' }); continue }
    if ((erpCount.get(key) ?? 0) > 1) { result.unmatched.push({ variationId: v.variationId, sku: v.sku, reason: 'duplicate_erp_sku' }); continue }
    const candidates = remoteBySku.get(key) ?? []
    if (candidates.length > 1) { result.unmatched.push({ variationId: v.variationId, sku: v.sku, reason: 'duplicate_remote_sku' }); continue }
    const match = candidates[0]
    if (!match || excluded.has(String(match.id))) { result.unmatched.push({ variationId: v.variationId, sku: v.sku, reason: 'not_found_remote' }); continue }
    result.pairs.push({ variationId: v.variationId, remoteVariantId: String(match.id) })
  }
  return result
}
