/**
 * Núcleo puro de comparação Varejo × Atacado × Total — Fase Analytics
 * Varejo/Atacado.
 *
 * Reaproveita, sem redefinir, as MESMAS grandezas já usadas pelo resto do
 * ERP (auditadas nesta fase):
 *   - receita  = SUM(sales.total)               — igual a dashboard.ts
 *     (`period.revenue`), relatorios/vendas (`totalRevenue`) e
 *     getSellerReport (`revenue`). Já exclui cancelada/devolvida — quem
 *     chama esta função só deve passar vendas com
 *     `status NOT IN ('cancelled','returned')` (mesmo filtro usado em
 *     TODOS os pontos acima).
 *   - lucro bruto = SUM(sale_items.gross_profit) — igual a dashboard.ts
 *     (`grossProfit`) e getSellerReport (`grossProfit`).
 *   - CMV = receita − lucro bruto — forçado algebricamente pela própria
 *     fórmula pedida ("lucro bruto = receita − CMV"), nunca uma soma
 *     independente de unit_cost×quantity: usar as DUAS grandezas que já
 *     existem no resto do ERP e derivar a terceira evita divergência de
 *     arredondamento entre duas fontes diferentes de "custo", e evita
 *     inventar uma segunda definição de CMV (proibido explicitamente).
 *
 * Módulo 100% puro — nenhuma chamada de rede/banco, nunca lança. Quem
 * carrega os dados (`src/services/analytics/modalityAnalytics.ts`) já
 * aplica os filtros de tenant/período/status; esta função só agrega o que
 * recebeu.
 */

export type SaleModality = 'retail' | 'wholesale'

export interface ModalitySaleInput {
  saleType: SaleModality
  /** sales.total da venda (já líquida de desconto/cashback, bruta de CMV) — mesma grandeza de "faturamento" usada em todo o ERP. */
  total: number
  /** SUM(sale_items.gross_profit) desta venda. */
  grossProfit: number
  /** SUM(sale_items.quantity) desta venda — "itens vendidos". */
  itemsQuantity: number
}

export interface ModalityMetrics {
  revenue: number
  orders: number
  avgTicket: number
  itemsSold: number
  cmv: number
  grossProfit: number
  /** null quando revenue <= 0 — nunca 0/NaN/Infinity fingindo ser uma margem real. */
  grossMarginPct: number | null
  /** 0-100. 0 quando a receita total (todas as modalidades) é 0. */
  revenueSharePct: number
  /** 0-100. 0 quando o lucro bruto total (todas as modalidades) é 0. */
  grossProfitSharePct: number
}

export interface ModalityComparison {
  retail: ModalityMetrics
  wholesale: ModalityMetrics
  total: ModalityMetrics
}

interface Accumulator {
  revenue: number
  orders: number
  itemsSold: number
  grossProfit: number
}

function emptyAccumulator(): Accumulator {
  return { revenue: 0, orders: 0, itemsSold: 0, grossProfit: 0 }
}

function toMetrics(acc: Accumulator, totalRevenue: number, totalGrossProfit: number): ModalityMetrics {
  const cmv = acc.revenue - acc.grossProfit
  return {
    revenue: acc.revenue,
    orders: acc.orders,
    avgTicket: acc.orders > 0 ? acc.revenue / acc.orders : 0,
    itemsSold: acc.itemsSold,
    cmv,
    grossProfit: acc.grossProfit,
    grossMarginPct: acc.revenue > 0 ? (acc.grossProfit / acc.revenue) * 100 : null,
    revenueSharePct: totalRevenue > 0 ? (acc.revenue / totalRevenue) * 100 : 0,
    grossProfitSharePct: totalGrossProfit > 0 ? (acc.grossProfit / totalGrossProfit) * 100 : 0,
  }
}

/**
 * Agrega vendas JÁ FILTRADAS (venda válida, período, tenant, canal se
 * aplicável) em Varejo / Atacado / Total. Nunca filtra nada sozinha —
 * cada `ModalitySaleInput` recebido é tratado como elegível.
 */
export function computeModalityComparison(sales: ModalitySaleInput[]): ModalityComparison {
  const retailAcc = emptyAccumulator()
  const wholesaleAcc = emptyAccumulator()

  for (const sale of sales) {
    const acc = sale.saleType === 'wholesale' ? wholesaleAcc : retailAcc
    acc.revenue += Number(sale.total ?? 0)
    acc.orders += 1
    acc.itemsSold += Number(sale.itemsQuantity ?? 0)
    acc.grossProfit += Number(sale.grossProfit ?? 0)
  }

  const totalAcc: Accumulator = {
    revenue: retailAcc.revenue + wholesaleAcc.revenue,
    orders: retailAcc.orders + wholesaleAcc.orders,
    itemsSold: retailAcc.itemsSold + wholesaleAcc.itemsSold,
    grossProfit: retailAcc.grossProfit + wholesaleAcc.grossProfit,
  }

  const totalRevenue = totalAcc.revenue
  const totalGrossProfit = totalAcc.grossProfit

  return {
    retail: toMetrics(retailAcc, totalRevenue, totalGrossProfit),
    wholesale: toMetrics(wholesaleAcc, totalRevenue, totalGrossProfit),
    total: toMetrics(totalAcc, totalRevenue, totalGrossProfit),
  }
}
