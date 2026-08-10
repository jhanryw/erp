/**
 * Sugestão de Compras — cobertura-alvo por Curva ABC.
 *
 * Fonte de dados (nenhuma tabela/view nova criada):
 *   - public.vw_purchase_suggestions -> estoque atual, vendas 30d/90d,
 *     custo unitário estimado e fornecedor recomendado (arquitetura
 *     existente, intocada por este arquivo).
 *   - public.mv_abc_by_revenue -> Curva ABC por PRODUTO (fonte de
 *     verdade existente, não recalculada aqui — só consumida).
 *   - public.product_variations.created_at -> idade do SKU, para a
 *     política de "produto novo" (não existe outro campo de
 *     "disponibilidade" no schema; created_at é o mais próximo e já
 *     confiável, sem inventar dado novo).
 *   - public.products.category_id / public.categories.name -> filtro
 *     por categoria na tela (pedido explícito da tarefa; não existia
 *     antes na tela).
 *
 * IMPORTANTE — Curva ABC continua sendo por PRODUTO (mv_abc_by_revenue é
 * agrupada por product_id, não por variação — isso já era assim antes
 * desta mudança e não foi alterado). Cada variação herda a classe ABC do
 * seu produto pai. A quantidade sugerida, porém, continua calculada por
 * SKU/variação (current_qty, qty_sold_30d/90d já vêm por variação da
 * própria vw_purchase_suggestions).
 *
 * IMPORTANTE — incoming_stock (estoque a receber): NÃO existe no ERP.
 * Não há purchase_orders, nem coluna de reserva/trânsito em
 * stock_balances/stock_movements (confirmado por auditoria anterior,
 * nesta mesma base). suggested_qty usa a fórmula de fallback
 * (target_stock - available_stock), sem descontar nada de "a receber".
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  COVERAGE_TARGET_DAYS,
  MIN_REPLENISH_QTY_C,
  NEW_PRODUCT_MAX_AGE_DAYS,
  PRIORITY_ORDER,
  PRIORITY_RESTANTES,
  PRIORITY_CURVA_C,
  URGENCY_THRESHOLDS_A,
  URGENCY_THRESHOLDS_B,
  type PolicyCurve,
  type PolicyUrgency,
} from '@/lib/constants/purchasePolicy'

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Linha crua de public.vw_purchase_suggestions — contrato da view, não alterado aqui. */
export interface PurchaseSuggestionRow {
  product_id: number
  product_name: string
  sku: string
  product_variation_id: number
  sku_variation: string
  color: string | null
  size: string | null
  current_qty: number
  qty_sold_30d: number
  qty_sold_90d: number
  daily_velocity: string
  estimated_lead_time_days: number
  coverage_days: number | null
  min_stock_suggested: number
  suggested_purchase_qty: number
  recommended_supplier_id: number | null
  recommended_supplier_name: string | null
  recommended_avg_cost_per_unit: string | null
  estimated_restock_cost: string
  urgency: 'critica' | 'alta' | 'media' | 'baixa'
  is_rupture: boolean
  is_dead_stock: boolean
  is_overstock: boolean
  target_stock_days: number
  margin_pct: number
  selling_price: number
  unit_cost_estimate: string
}

export interface EnrichedPurchaseSuggestion {
  productId: number
  productName: string
  sku: string
  productVariationId: number
  skuVariation: string
  color: string | null
  size: string | null
  categoryId: number | null
  categoryName: string | null

  availableStock: number
  incomingStock: number | null // sempre null hoje — não existe a fonte (ver nota do módulo)

  qtySold30d: number
  qtySold90d: number
  vmd30: number
  vmd90: number
  vmdProjetada: number

  /** Curva ABC bruta de mv_abc_by_revenue (por produto). Null = produto sem receita registrada, nunca entrou na ABC. */
  abcClassRaw: 'A' | 'B' | 'C' | null
  /** Curva usada para a política de reposição — igual a abcClassRaw, exceto quando o SKU é "novo" (ver isNewProduct). */
  policyCurve: PolicyCurve
  isNewProduct: boolean
  variationCreatedAt: string

  coverageDays: number | null
  targetDays: number | null // null para Curva C (não usa target de dias)
  targetStock: number | null // null para Curva C

  suggestedQty: number
  unitCostEstimate: number
  estimatedCost: number

  postPurchaseStock: number
  postPurchaseCoverageDays: number | null

  urgency: PolicyUrgency

  recommendedSupplierId: number | null
  recommendedSupplierName: string | null
  recommendedAvgCostPerUnit: number | null
}

export interface CurveSummary {
  curve: PolicyCurve
  skuCount: number
  skuWithSuggestionCount: number
  ruptureCount: number
  estimatedCost: number
  suggestedUnits: number
}

export interface PurchaseSuggestionsSummary {
  byCurve: Record<PolicyCurve, CurveSummary>
  totalEstimatedCost: number
  totalSuggestedUnits: number
  currentStockValueAtCost: number
  theoreticalStockValueAfterPurchase: number
}

// ─── Cálculo puro (testável isoladamente, sem I/O) ─────────────────────────────

function ageInDays(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime()
  return Math.max(0, (now.getTime() - from) / 86_400_000)
}

/**
 * Curva efetiva para política de reposição.
 *
 * "Novo" (target 30 dias) só se aplica pela IDADE do SKU (<30 dias desde
 * product_variations.created_at) — nunca mais pela mera ausência de
 * classificação ABC. Um produto com 30+ dias que nunca entrou em
 * mv_abc_by_revenue (sem receita registrada) vira NO_ABC, com a mesma
 * política conservadora da Curva C (nunca fica "Novo" para sempre).
 * Depois da janela de 30 dias, um SKU que já tem abc_class usa A/B/C
 * normalmente.
 */
export function resolvePolicyCurve(
  abcClassRaw: 'A' | 'B' | 'C' | null,
  variationCreatedAt: string,
  now: Date,
): { curve: PolicyCurve; isNew: boolean } {
  const isNew = ageInDays(variationCreatedAt, now) < NEW_PRODUCT_MAX_AGE_DAYS
  if (isNew) return { curve: 'NEW', isNew: true }
  if (abcClassRaw === null) return { curve: 'NO_ABC', isNew: false }
  return { curve: abcClassRaw, isNew: false }
}

function urgencyByThresholds(
  coverageDays: number | null,
  thresholds: { maxDays: number; urgency: PolicyUrgency; exclusive?: boolean }[],
): PolicyUrgency {
  if (coverageDays === null) return 'ok' // sem velocidade: não gera compra automática, não é urgente
  for (const t of thresholds) {
    if (t.exclusive ? coverageDays < t.maxDays : coverageDays <= t.maxDays) return t.urgency
  }
  return 'ok'
}

/**
 * Núcleo da fórmula — recebe os dados já buscados (nenhum I/O aqui) e
 * devolve a linha enriquecida. Mantido puro de propósito para ser fácil
 * de testar/validar com os cenários do enunciado.
 */
export function computeReplenishment(
  row: PurchaseSuggestionRow,
  ctx: {
    abcClassRaw: 'A' | 'B' | 'C' | null
    variationCreatedAt: string
    categoryId: number | null
    categoryName: string | null
  },
  now: Date = new Date(),
): EnrichedPurchaseSuggestion {
  // Estoque nunca deve ser negativo (constraint no banco já garante isso;
  // clamp defensivo aqui só por segurança de cálculo, não por desconfiança do dado).
  const availableStock = Math.max(0, Number(row.current_qty) || 0)
  const qtySold30d = Math.max(0, Number(row.qty_sold_30d) || 0)
  const qtySold90d = Math.max(0, Number(row.qty_sold_90d) || 0)
  const unitCostEstimate = Math.max(0, Number(row.unit_cost_estimate) || 0)

  // Velocidade média diária — decimal, sem arredondar antes do estoque-alvo.
  const vmd30 = qtySold30d / 30
  const vmd90 = qtySold90d / 90
  const vmdProjetada = Math.max(vmd30, vmd90)

  const { curve, isNew } = resolvePolicyCurve(ctx.abcClassRaw, ctx.variationCreatedAt, now)

  const coverageDays = vmdProjetada > 0 ? availableStock / vmdProjetada : null

  let targetDays: number | null = null
  let targetStock: number | null = null
  let suggestedQty = 0
  let urgency: PolicyUrgency

  if (curve === 'C' || curve === 'NO_ABC') {
    // Curva C e NO_ABC não usam target de dias — mesma regra conservadora
    // de mínimo de reposição (produto sem classificação ABC confiável
    // não deve gerar compra além do essencial).
    const houveVendaRecente = vmdProjetada > 0
    if (availableStock > 0) {
      suggestedQty = 0
    } else if (houveVendaRecente) {
      suggestedQty = MIN_REPLENISH_QTY_C
    } else {
      suggestedQty = 0
    }
    urgency = suggestedQty > 0 ? 'reposicao_minima' : 'nao_repor'
  } else {
    targetDays = COVERAGE_TARGET_DAYS[curve]
    targetStock = Math.ceil(vmdProjetada * targetDays)
    // incoming_stock não existe na arquitetura atual — fórmula de fallback documentada.
    suggestedQty = Math.max(0, targetStock - availableStock)
    urgency =
      curve === 'A'
        ? urgencyByThresholds(coverageDays, URGENCY_THRESHOLDS_A)
        : urgencyByThresholds(coverageDays, URGENCY_THRESHOLDS_B) // B e NEW reutilizam a mesma lógica proporcional
  }

  const estimatedCost = Math.round(suggestedQty * unitCostEstimate * 100) / 100

  const incomingStock = null // sempre null hoje — sem fonte confiável no ERP (ver nota do módulo)
  const postPurchaseStock = availableStock + (incomingStock ?? 0) + suggestedQty
  const postPurchaseCoverageDays = vmdProjetada > 0 ? postPurchaseStock / vmdProjetada : null

  return {
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    productVariationId: row.product_variation_id,
    skuVariation: row.sku_variation,
    color: row.color,
    size: row.size,
    categoryId: ctx.categoryId,
    categoryName: ctx.categoryName,

    availableStock,
    incomingStock,

    qtySold30d,
    qtySold90d,
    vmd30,
    vmd90,
    vmdProjetada,

    abcClassRaw: ctx.abcClassRaw,
    policyCurve: curve,
    isNewProduct: isNew,
    variationCreatedAt: ctx.variationCreatedAt,

    coverageDays,
    targetDays,
    targetStock,

    suggestedQty,
    unitCostEstimate,
    estimatedCost,

    postPurchaseStock,
    postPurchaseCoverageDays,

    urgency,

    recommendedSupplierId: row.recommended_supplier_id,
    recommendedSupplierName: row.recommended_supplier_name,
    recommendedAvgCostPerUnit: row.recommended_avg_cost_per_unit
      ? Number(row.recommended_avg_cost_per_unit)
      : null,
  }
}

/** Ordem de exibição padrão (seção 14 do pedido): A crítica…baixa, Novo crítica/alta, B crítica/alta, restantes, C por último. */
export function priorityRank(curve: PolicyCurve, urgency: PolicyUrgency): number {
  if (curve === 'C') return PRIORITY_CURVA_C
  return PRIORITY_ORDER[`${curve}|${urgency}`] ?? PRIORITY_RESTANTES
}

export function sortBySuggestedPriority(
  items: EnrichedPurchaseSuggestion[],
): EnrichedPurchaseSuggestion[] {
  return [...items].sort((a, b) => {
    const r = priorityRank(a.policyCurve, a.urgency) - priorityRank(b.policyCurve, b.urgency)
    if (r !== 0) return r
    return b.estimatedCost - a.estimatedCost
  })
}

export function summarizeByCurve(items: EnrichedPurchaseSuggestion[]): PurchaseSuggestionsSummary {
  const curves: PolicyCurve[] = ['A', 'B', 'C', 'NEW', 'NO_ABC']
  const byCurve = {} as Record<PolicyCurve, CurveSummary>

  for (const curve of curves) {
    const rows = items.filter((i) => i.policyCurve === curve)
    byCurve[curve] = {
      curve,
      skuCount: rows.length,
      skuWithSuggestionCount: rows.filter((r) => r.suggestedQty > 0).length,
      ruptureCount: rows.filter((r) => r.availableStock === 0 && r.vmdProjetada > 0).length,
      estimatedCost: rows.reduce((s, r) => s + r.estimatedCost, 0),
      suggestedUnits: rows.reduce((s, r) => s + r.suggestedQty, 0),
    }
  }

  const totalEstimatedCost = curves.reduce((s, c) => s + byCurve[c].estimatedCost, 0)
  const totalSuggestedUnits = curves.reduce((s, c) => s + byCurve[c].suggestedUnits, 0)
  const currentStockValueAtCost = items.reduce(
    (s, i) => s + i.availableStock * i.unitCostEstimate,
    0,
  )

  return {
    byCurve,
    totalEstimatedCost,
    totalSuggestedUnits,
    currentStockValueAtCost,
    theoreticalStockValueAfterPurchase: currentStockValueAtCost + totalEstimatedCost,
  }
}

// ─── Busca de dados (I/O) ───────────────────────────────────────────────────────

/**
 * Busca e enriquece as sugestões de compra. 4 queries no total, todas em
 * lote (sem N+1): a view, variações (created_at), ABC por produto e
 * categorias — os ids de busca das 3 últimas vêm da própria view, então
 * o custo escala com o tamanho do resultado, não com uma query por linha.
 */
export async function getEnrichedPurchaseSuggestions(): Promise<EnrichedPurchaseSuggestion[]> {
  const admin = createAdminClient()

  const { data: rawRows, error } = await (admin as any)
    .from('vw_purchase_suggestions')
    .select('*') as unknown as { data: PurchaseSuggestionRow[] | null; error: any }

  if (error) throw new Error(`getEnrichedPurchaseSuggestions: ${error.message}`)
  const rows = rawRows ?? []
  if (rows.length === 0) return []

  const variationIds = [...new Set(rows.map((r) => r.product_variation_id))]
  const productIds = [...new Set(rows.map((r) => r.product_id))]

  const [variationsRes, abcRes, productsRes] = await Promise.all([
    admin
      .from('product_variations')
      .select('id, created_at')
      .in('id', variationIds) as unknown as Promise<{
      data: { id: number; created_at: string }[] | null
    }>,
    (admin as any)
      .from('mv_abc_by_revenue')
      .select('product_id, abc_class')
      .in('product_id', productIds) as unknown as Promise<{
      data: { product_id: number; abc_class: 'A' | 'B' | 'C' }[] | null
    }>,
    admin
      .from('products')
      .select('id, category_id')
      .in('id', productIds) as unknown as Promise<{
      data: { id: number; category_id: number | null }[] | null
    }>,
  ])

  const createdAtByVariation = new Map(
    (variationsRes.data ?? []).map((v) => [v.id, v.created_at]),
  )
  const abcByProduct = new Map((abcRes.data ?? []).map((a) => [a.product_id, a.abc_class]))
  const categoryIdByProduct = new Map(
    (productsRes.data ?? []).map((p) => [p.id, p.category_id]),
  )

  const categoryIds = [...new Set([...categoryIdByProduct.values()].filter((id): id is number => id !== null))]
  let categoryNameById = new Map<number, string>()
  if (categoryIds.length > 0) {
    const { data: categories } = (await admin
      .from('categories')
      .select('id, name')
      .in('id', categoryIds)) as unknown as { data: { id: number; name: string }[] | null }
    categoryNameById = new Map((categories ?? []).map((c) => [c.id, c.name]))
  }

  const now = new Date()

  return rows.map((row) => {
    const categoryId = categoryIdByProduct.get(row.product_id) ?? null
    return computeReplenishment(row, {
      abcClassRaw: abcByProduct.get(row.product_id) ?? null,
      // created_at da variação é a fonte real (ver comentário do módulo);
      // fallback defensivo para "agora" (trata como novo) só se, por
      // algum motivo, a variação não vier na busca em lote acima.
      variationCreatedAt: createdAtByVariation.get(row.product_variation_id) ?? now.toISOString(),
      categoryId,
      categoryName: categoryId !== null ? categoryNameById.get(categoryId) ?? null : null,
    }, now)
  })
}
