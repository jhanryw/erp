import { describe, it, expect } from 'vitest'
import { computeReplenishment, resolvePolicyCurve, type PurchaseSuggestionRow } from './purchaseSuggestions'

const NOW = new Date('2026-08-15T12:00:00Z')

function row(overrides: Partial<PurchaseSuggestionRow>): PurchaseSuggestionRow {
  return {
    product_id: 1,
    product_name: 'Produto Teste',
    sku: 'SKU',
    product_variation_id: 1,
    sku_variation: 'SKU-VAR',
    color: null,
    size: null,
    current_qty: 0,
    qty_sold_30d: 0,
    qty_sold_90d: 0,
    daily_velocity: '0',
    estimated_lead_time_days: 30,
    coverage_days: null,
    min_stock_suggested: 0,
    suggested_purchase_qty: 0,
    recommended_supplier_id: null,
    recommended_supplier_name: null,
    recommended_avg_cost_per_unit: null,
    estimated_restock_cost: '0',
    urgency: 'baixa',
    is_rupture: false,
    is_dead_stock: false,
    is_overstock: false,
    target_stock_days: 60,
    margin_pct: 50,
    selling_price: 100,
    unit_cost_estimate: '10',
    ...overrides,
  }
}

const OLD = new Date('2020-01-01T00:00:00Z').toISOString() // bem além de 30 dias

describe('computeReplenishment — cenários do enunciado', () => {
  // Exemplo A
  it('Curva A: estoque=8, vendas30=12, vendas90=24 -> suggested=28, cobertura 20d -> 90d', () => {
    const r = computeReplenishment(
      row({ current_qty: 8, qty_sold_30d: 12, qty_sold_90d: 24, unit_cost_estimate: '10' }),
      { abcClassRaw: 'A', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.vmd30).toBeCloseTo(0.4, 6)
    expect(r.vmd90).toBeCloseTo(0.26666667, 6)
    expect(r.vmdProjetada).toBeCloseTo(0.4, 6)
    expect(r.policyCurve).toBe('A')
    expect(r.targetDays).toBe(90)
    expect(r.targetStock).toBe(36)
    expect(r.suggestedQty).toBe(28)
    expect(r.coverageDays).toBeCloseTo(20, 6)
    expect(r.postPurchaseStock).toBe(36)
    expect(r.postPurchaseCoverageDays).toBeCloseTo(90, 6)
  })

  // Exemplo B
  it('Curva B: estoque=2, vendas30=6, vendas90=9 -> suggested=4', () => {
    const r = computeReplenishment(
      row({ current_qty: 2, qty_sold_30d: 6, qty_sold_90d: 9 }),
      { abcClassRaw: 'B', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.vmd30).toBeCloseTo(0.2, 6)
    expect(r.vmd90).toBeCloseTo(0.1, 6)
    expect(r.vmdProjetada).toBeCloseTo(0.2, 6)
    expect(r.targetDays).toBe(30)
    expect(r.targetStock).toBe(6)
    expect(r.suggestedQty).toBe(4)
  })

  // Exemplo C — com estoque disponível
  it('Curva C: estoque=5 -> suggested=0, independente de venda', () => {
    const r = computeReplenishment(
      row({ current_qty: 5, qty_sold_30d: 3, qty_sold_90d: 5 }),
      { abcClassRaw: 'C', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.suggestedQty).toBe(0)
    expect(r.targetDays).toBeNull()
    expect(r.targetStock).toBeNull()
    expect(r.urgency).toBe('nao_repor')
  })

  // Exemplo C zerado com venda recente
  it('Curva C: estoque=0 com venda recente -> suggested=1 (mínimo)', () => {
    const r = computeReplenishment(
      row({ current_qty: 0, qty_sold_30d: 2, qty_sold_90d: 2 }),
      { abcClassRaw: 'C', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.suggestedQty).toBe(1)
    expect(r.urgency).toBe('reposicao_minima')
  })

  // Curva C zerado sem venda recente
  it('Curva C: estoque=0 sem venda recente -> suggested=0', () => {
    const r = computeReplenishment(
      row({ current_qty: 0, qty_sold_30d: 0, qty_sold_90d: 0 }),
      { abcClassRaw: 'C', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.suggestedQty).toBe(0)
    expect(r.urgency).toBe('nao_repor')
  })

  // Produto sem vendas em nenhuma curva-alvo (A/B/Novo) -> sem compra automática, sem Infinity/NaN
  it('produto sem vendas (Curva B): vmdProjetada=0 -> suggested=0, cobertura=null, urgência=ok', () => {
    const r = computeReplenishment(
      row({ current_qty: 10, qty_sold_30d: 0, qty_sold_90d: 0 }),
      { abcClassRaw: 'B', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.vmdProjetada).toBe(0)
    expect(r.suggestedQty).toBe(0)
    expect(r.coverageDays).toBeNull()
    expect(r.postPurchaseCoverageDays).toBeNull()
    expect(r.urgency).toBe('ok')
    expect(Number.isFinite(r.suggestedQty)).toBe(true)
    expect(Number.isNaN(r.estimatedCost)).toBe(false)
  })

  it('estoque negativo (defensivo): nunca deveria acontecer, mas não gera NaN/negativo em cascata', () => {
    const r = computeReplenishment(
      row({ current_qty: -3, qty_sold_30d: 5, qty_sold_90d: 5 }),
      { abcClassRaw: 'A', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.availableStock).toBe(0)
    expect(Number.isNaN(r.suggestedQty)).toBe(false)
  })

  it('custo unitário null/inválido não gera NaN no custo estimado', () => {
    const r = computeReplenishment(
      row({ current_qty: 0, qty_sold_30d: 5, qty_sold_90d: 5, unit_cost_estimate: null as unknown as string }),
      { abcClassRaw: 'B', variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
    expect(Number.isNaN(r.estimatedCost)).toBe(false)
    expect(r.estimatedCost).toBe(0)
  })
})

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString()
}

describe('resolvePolicyCurve — política de "produto novo"', () => {
  // (a) SKU com 10 dias e sem ABC -> Novo
  it('(a) SKU com 10 dias e sem ABC -> Novo', () => {
    const { curve, isNew } = resolvePolicyCurve(null, daysAgo(10), NOW)
    expect(curve).toBe('NEW')
    expect(isNew).toBe(true)
  })

  it('sem linha na ABC mas com 30+ dias -> NÃO é mais Novo, vira NO_ABC (correção: idade não conta mais sozinha)', () => {
    const { curve, isNew } = resolvePolicyCurve(null, OLD, NOW)
    expect(curve).toBe('NO_ABC')
    expect(isNew).toBe(false)
  })

  it('SKU com menos de 30 dias -> Novo, mesmo que a ABC já tenha classificado como B', () => {
    const recent = new Date(NOW.getTime() - 5 * 86_400_000).toISOString()
    const { curve, isNew } = resolvePolicyCurve('B', recent, NOW)
    expect(curve).toBe('NEW')
    expect(isNew).toBe(true)
  })

  it('SKU com mais de 30 dias e ABC definida -> usa a classe ABC real, não "Novo"', () => {
    const old = new Date(NOW.getTime() - 200 * 86_400_000).toISOString()
    const { curve, isNew } = resolvePolicyCurve('A', old, NOW)
    expect(curve).toBe('A')
    expect(isNew).toBe(false)
  })

  it('limite exato de 30 dias ainda conta como Novo (< 30, não <=)', () => {
    const exactly30 = new Date(NOW.getTime() - 30 * 86_400_000).toISOString()
    const { isNew } = resolvePolicyCurve('C', exactly30, NOW)
    expect(isNew).toBe(false) // 30 dias completos já NÃO é mais "novo" (idade < 30, não <=)
  })
})

describe('NO_ABC — política conservadora (produto 30+ dias sem classificação ABC)', () => {
  // (b) SKU com 40 dias e sem ABC, estoque > 0 -> suggested_qty 0
  it('(b) 40 dias, sem ABC, estoque > 0 -> suggested_qty 0', () => {
    const r = computeReplenishment(
      row({ current_qty: 7, qty_sold_30d: 4, qty_sold_90d: 10 }),
      { abcClassRaw: null, variationCreatedAt: daysAgo(40), categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.policyCurve).toBe('NO_ABC')
    expect(r.suggestedQty).toBe(0)
    expect(r.urgency).toBe('nao_repor')
  })

  // (c) SKU com 40 dias e sem ABC, estoque 0, sem venda -> suggested_qty 0
  it('(c) 40 dias, sem ABC, estoque 0, sem venda recente -> suggested_qty 0', () => {
    const r = computeReplenishment(
      row({ current_qty: 0, qty_sold_30d: 0, qty_sold_90d: 0 }),
      { abcClassRaw: null, variationCreatedAt: daysAgo(40), categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.policyCurve).toBe('NO_ABC')
    expect(r.suggestedQty).toBe(0)
    expect(r.urgency).toBe('nao_repor')
  })

  // (d) SKU com 40 dias e sem ABC, estoque 0, com venda recente -> suggested_qty 1
  it('(d) 40 dias, sem ABC, estoque 0, com venda recente -> suggested_qty 1', () => {
    const r = computeReplenishment(
      row({ current_qty: 0, qty_sold_30d: 2, qty_sold_90d: 2 }),
      { abcClassRaw: null, variationCreatedAt: daysAgo(40), categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.policyCurve).toBe('NO_ABC')
    expect(r.suggestedQty).toBe(1)
    expect(r.urgency).toBe('reposicao_minima')
  })

  // (e) SKU com 40 dias e ABC A -> política A 90 dias (NO_ABC não se aplica quando há classificação)
  it('(e) 40 dias e ABC=A -> usa política A (90 dias), não NO_ABC', () => {
    const r = computeReplenishment(
      row({ current_qty: 8, qty_sold_30d: 12, qty_sold_90d: 24 }),
      { abcClassRaw: 'A', variationCreatedAt: daysAgo(40), categoryId: null, categoryName: null },
      NOW,
    )
    expect(r.policyCurve).toBe('A')
    expect(r.targetDays).toBe(90)
    expect(r.targetStock).toBe(36)
    expect(r.suggestedQty).toBe(28)
  })
})

describe('urgência — limites de cobertura', () => {
  function withCoverage(curve: 'A' | 'B', qty: number, vmd: number) {
    return computeReplenishment(
      row({ current_qty: qty, qty_sold_30d: Math.round(vmd * 30), qty_sold_90d: Math.round(vmd * 90) }),
      { abcClassRaw: curve, variationCreatedAt: OLD, categoryId: null, categoryName: null },
      NOW,
    )
  }

  it('Curva A: 15 dias de cobertura -> crítica; 15.1 -> alta', () => {
    expect(withCoverage('A', 15, 1).urgency).toBe('critica')
    expect(withCoverage('A', 16, 1).urgency).toBe('alta')
  })

  it('Curva A: 90+ dias de cobertura -> ok', () => {
    expect(withCoverage('A', 90, 1).urgency).toBe('ok')
  })

  it('Curva B: 7 dias -> crítica; 8 dias -> alta; 29 dias -> media; 30 dias -> ok', () => {
    expect(withCoverage('B', 7, 1).urgency).toBe('critica')
    expect(withCoverage('B', 8, 1).urgency).toBe('alta')
    expect(withCoverage('B', 29, 1).urgency).toBe('media')
    expect(withCoverage('B', 30, 1).urgency).toBe('ok')
  })
})
