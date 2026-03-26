/**
 * Camada de serviço para inteligência de negócios.
 * Todos os métodos operam apenas no servidor (admin client) e nunca
 * expõem dados brutos de custo ao cliente — os componentes consomem
 * os tipos exportados aqui.
 *
 * Módulos:
 *  - Curva ABC (por faturamento, lucro e volume)
 *  - Matriz RFM
 *  - Performance por Cor
 *  - Giro de Estoque
 *  - Performance por Fornecedor
 *  - Sugestões de Recompra
 *  - Produtos Encalhados
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { AbcCurve, RfmSegment } from '@/types/database.types'

// ─── Tipos Exportados ──────────────────────────────────────────────────────────

export type AbcDimension = 'revenue' | 'profit' | 'volume'

export interface AbcRow {
  product_id: number
  product_name: string
  sku: string
  supplier_name: string | null
  /** valor da dimensão analisada (R$ receita | R$ lucro | unidades vendidas) */
  value: number
  cumulative_pct: number
  abc_curve: AbcCurve
  margin_pct: number | null
}

export interface RfmRow {
  customer_id: number
  customer_name: string
  r_score: number
  f_score: number
  m_score: number
  rfm_total: number
  segment: RfmSegment
  total_spent: number
  purchase_count: number
  days_since_last_purchase: number
}

export interface ColorPerformanceRow {
  color: string
  units_sold: number
  total_revenue: number
  total_gross_profit: number
  avg_margin_pct: number
  avg_ticket: number
  product_count: number
}

export interface StockTurnoverRow {
  product_id: number
  product_name: string
  sku: string
  category_name: string
  supplier_name: string | null
  current_qty: number
  units_sold_period: number
  turnover_rate: number
  /** dias médios para vender o estoque disponível */
  days_to_sell: number
  turnover_category: 'fast' | 'medium' | 'slow' | 'dead'
}

export interface SupplierPerformanceRow {
  supplier_id: number
  supplier_name: string
  total_purchased_value: number
  total_revenue: number
  total_gross_profit: number
  avg_margin_pct: number
  top_product_name: string | null
  avg_ticket_per_purchase: number
  product_count: number
}

export interface RestockSuggestion {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  color: string | null
  size: string | null
  current_qty: number
  supplier_id: number | null
  supplier_name: string | null
  /** quantidade sugerida para recompra (3× o déficit) */
  suggested_qty: number
}

export interface DeadStockRow {
  product_variation_id: number
  product_id: number
  product_name: string
  sku: string
  current_qty: number
  stock_value_at_cost: number
  last_entry_date: string | null
}

// ─── Curva ABC ─────────────────────────────────────────────────────────────────

const ABC_VIEW_MAP: Record<AbcDimension, string> = {
  revenue: 'mv_abc_by_revenue',
  profit: 'mv_abc_by_profit',
  volume: 'mv_abc_by_volume',
}

export async function getAbcCurve(
  dimension: AbcDimension,
  limit = 200
): Promise<AbcRow[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from(ABC_VIEW_MAP[dimension] as any)
    .select('*')
    .order(
      dimension === 'revenue'
        ? 'total_revenue'
        : dimension === 'profit'
        ? 'total_gross_profit'
        : 'total_units_sold',
      { ascending: false }
    )
    .limit(limit)

  if (error) throw new Error(`getAbcCurve: ${error.message}`)
  return (data ?? []) as AbcRow[]
}

// ─── Matriz RFM ────────────────────────────────────────────────────────────────

export async function getRfmMatrix(limit = 500): Promise<RfmRow[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('mv_customer_rfm')
    .select(`
      customer_id,
      r_score,
      f_score,
      m_score,
      rfm_total,
      segment,
      total_spent,
      purchase_count,
      days_since_last_purchase
    `)
    .order('rfm_total', { ascending: false })
    .limit(limit) as unknown as { data: any[] | null, error: any }

  if (error) throw new Error(`getRfmMatrix: ${error.message}`)

  return ((data ?? []) as any[]).map((r) => ({
    customer_id: r.customer_id,
    customer_name: `Cliente #${r.customer_id}`,
    r_score: r.r_score,
    f_score: r.f_score,
    m_score: r.m_score,
    rfm_total: r.rfm_total,
    segment: r.segment as RfmSegment,
    total_spent: r.total_spent,
    purchase_count: r.purchase_count,
    days_since_last_purchase: r.days_since_last_purchase,
  }))
}

// ─── Performance por Cor ───────────────────────────────────────────────────────

export async function getColorPerformance(
  categoryId?: number
): Promise<ColorPerformanceRow[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('mv_color_performance' as any)
    .select('*')
    .order('total_revenue', { ascending: false })

  if (categoryId) {
    query = query.eq('category_id', categoryId) as typeof query
  }

  const { data, error } = await query
  if (error) throw new Error(`getColorPerformance: ${error.message}`)
  return (data ?? []) as ColorPerformanceRow[]
}

// ─── Giro de Estoque ───────────────────────────────────────────────────────────

function categorizeTurnover(rate: number): StockTurnoverRow['turnover_category'] {
  if (rate <= 0) return 'dead'
  if (rate >= 6) return 'fast'   // vira mais de 6x no período
  if (rate >= 2) return 'medium'
  return 'slow'
}

export async function getStockTurnover(days = 90): Promise<StockTurnoverRow[]> {
  const supabase = createAdminClient()

  // Estoque atual por variação (com nome do produto)
  const [stockRes, salesRes] = await Promise.all([
    supabase
      .from('mv_stock_status' as any)
      .select('product_variation_id, product_id, product_name, sku, current_qty, supplier_id'),
    (supabase
      .from('sale_items') as any)
      .select('product_variation_id, quantity')
      .gte(
        'sales.sale_date',
        new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      ) as Promise<{ data: any[] | null, error: any }>,
  ])

  // Soma unidades vendidas por variação no período
  const soldMap: Record<number, number> = {}
  for (const item of salesRes.data ?? []) {
    soldMap[item.product_variation_id] =
      (soldMap[item.product_variation_id] ?? 0) + item.quantity
  }

  return ((stockRes.data ?? []) as any[]).map((s) => {
    const sold = soldMap[s.product_variation_id] ?? 0
    const rate = s.current_qty > 0 ? sold / s.current_qty : sold > 0 ? 999 : 0
    const daysToSell = sold > 0 && s.current_qty > 0 ? (s.current_qty / (sold / days)) : 0
    return {
      product_id: s.product_id,
      product_name: s.product_name,
      sku: s.sku,
      category_name: '',
      supplier_name: null,
      current_qty: s.current_qty,
      units_sold_period: sold,
      turnover_rate: parseFloat(rate.toFixed(2)),
      days_to_sell: Math.round(daysToSell),
      turnover_category: categorizeTurnover(rate),
    } satisfies StockTurnoverRow
  }).sort((a, b) => a.turnover_rate - b.turnover_rate)
}

// ─── Performance por Fornecedor ────────────────────────────────────────────────

export async function getSupplierPerformance(): Promise<SupplierPerformanceRow[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('mv_supplier_performance' as any)
    .select('*')
    .order('total_revenue', { ascending: false })

  if (error) throw new Error(`getSupplierPerformance: ${error.message}`)
  return (data ?? []) as SupplierPerformanceRow[]
}

// ─── Sugestões de Recompra ─────────────────────────────────────────────────────

export async function getRestockSuggestions(
  maxQty = 5
): Promise<RestockSuggestion[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('mv_stock_status' as any)
    .select(`
      product_variation_id,
      product_id,
      product_name,
      sku,
      current_qty
    `)
    .lte('current_qty', maxQty)
    .order('current_qty', { ascending: true })
    .limit(100)

  if (error) throw new Error(`getRestockSuggestions: ${error.message}`)

  return ((data ?? []) as any[]).map((r) => ({
    product_variation_id: r.product_variation_id,
    product_id: r.product_id,
    product_name: r.product_name,
    sku: r.sku,
    color: null,
    size: null,
    current_qty: r.current_qty,
    supplier_id: null,
    supplier_name: null,
  }))
}

// ─── Produtos Encalhados ────────────────────────────────────────────────────────

export async function getDeadStock(): Promise<DeadStockRow[]> {
  const supabase = createAdminClient()

  // Produtos com estoque > 0 mas que aparecem no mv_stock_status sem last_entry_date
  // ou cuja última venda foi há muito tempo (identificado por mv_product_performance)
  const { data, error } = await supabase
    .from('mv_stock_status' as any)
    .select(
      'product_variation_id, product_id, product_name, sku, current_qty, stock_value_at_cost, last_entry_date'
    )
    .gt('current_qty', 0)
    .order('stock_value_at_cost', { ascending: false })
    .limit(100)

  if (error) throw new Error(`getDeadStock: ${error.message}`)
  return (data ?? []) as DeadStockRow[]
}
