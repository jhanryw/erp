/**
 * Regras PURAS de kit / produto composto — espelho em TypeScript das funções
 * SQL da migration 202609231000/202609231100:
 *
 *   resolveStockRequirements  ↔ public.fn_resolve_stock_requirements
 *   computeKitAvailability    ↔ public.fn_variation_sellable_quantity (ramo kit)
 *   computeKitUnitCost        ↔ custo de kit em rpc_create_sale
 *   consolidateKitComponents  ↔ public._kit_normalize_components
 *
 * O banco é sempre a autoridade na venda (lock + validação na transação);
 * estas funções existem para a aplicação responder a mesma pergunta sem
 * reimplementar a fórmula em cada tela/integração, e são cobertas por teste
 * junto com o teste SQL (supabase/tests/product_kits.test.sql).
 *
 * Nenhum código de canal (Nuvemshop, Mercado Livre...) deve importar isto
 * diretamente para decidir "é kit?": canais perguntam a quantidade vendável
 * via `services/inventory/availability.service.ts`, que já resolve kit ou
 * produto normal de forma transparente.
 */

export interface KitComponentLine {
  component_product_variation_id: number
  /** Unidades do componente por unidade do kit (> 0). */
  quantity: number
}

export interface StockRequirementItem {
  product_variation_id: number
  quantity: number
}

export interface StockRequirement {
  product_variation_id: number
  quantity: number
}

/**
 * O que precisa sair do estoque FÍSICO para vender estes itens.
 * Produto normal → ele mesmo × quantidade. Kit → cada componente ×
 * quantidade_por_kit × quantidade. Agregado por variação e ordenado por id
 * (mesma ordem determinística dos locks em rpc_create_sale).
 *
 * `compositions` só precisa conter os kits; variação ausente do mapa é
 * tratada como produto normal. Kit presente com composição vazia é erro
 * (kit sem componentes nunca é vendável).
 */
export function resolveStockRequirements(
  items: StockRequirementItem[],
  compositions: ReadonlyMap<number, KitComponentLine[]>,
): StockRequirement[] {
  const totals = new Map<number, number>()
  const add = (pvid: number, qty: number) => totals.set(pvid, (totals.get(pvid) ?? 0) + qty)

  for (const item of items) {
    const composition = compositions.get(item.product_variation_id)
    if (!composition) {
      add(item.product_variation_id, item.quantity)
      continue
    }
    if (composition.length === 0) {
      throw new Error(`Kit sem composição (variação #${item.product_variation_id}) não pode ser vendido.`)
    }
    for (const line of composition) {
      add(line.component_product_variation_id, line.quantity * item.quantity)
    }
  }

  return [...totals.entries()]
    .map(([product_variation_id, quantity]) => ({ product_variation_id, quantity }))
    .sort((a, b) => a.product_variation_id - b.product_variation_id)
}

/** Quantos kits um componente sozinho permite: floor(disponível / qtd_por_kit). */
export function componentKitCapacity(available: number, quantityPerKit: number): number {
  if (quantityPerKit <= 0) return 0
  return Math.max(0, Math.floor(Math.max(0, available) / quantityPerKit))
}

/**
 * Disponibilidade derivada do kit = MIN(capacidade de cada componente).
 * Sem componentes → 0 (nunca vendável).
 */
export function computeKitAvailability(components: Array<{ quantity: number; available: number }>): number {
  if (components.length === 0) return 0
  return Math.min(...components.map((c) => componentKitCapacity(c.available, c.quantity)))
}

/** Componente que limita o kit (primeiro de menor capacidade), ou null. */
export function findBottleneck<T extends { quantity: number; available: number }>(components: T[]): T | null {
  let best: T | null = null
  let bestCap = Infinity
  for (const c of components) {
    const cap = componentKitCapacity(c.available, c.quantity)
    if (cap < bestCap) {
      best = c
      bestCap = cap
    }
  }
  return best
}

/** Custo do kit = SUM(custo do componente (2 casas) × qtd_por_kit), 2 casas. */
export function computeKitUnitCost(components: Array<{ quantity: number; unit_cost: number }>): number {
  const total = components.reduce((sum, c) => sum + roundMoney(c.unit_cost) * c.quantity, 0)
  return roundMoney(total)
}

/**
 * Consolida componentes repetidos somando as quantidades (determinístico,
 * ordenado por variação) e valida as regras estruturais que dependem só do
 * payload. Regras que dependem do banco (mesma empresa, componente não é
 * kit) ficam na RPC/trigger.
 */
export function consolidateKitComponents(
  components: KitComponentLine[],
  kitVariationId?: number | null,
): KitComponentLine[] {
  if (components.length === 0) {
    throw new Error('O kit precisa ter pelo menos um componente.')
  }
  const totals = new Map<number, number>()
  for (const c of components) {
    if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
      throw new Error(`Quantidade do componente #${c.component_product_variation_id} precisa ser maior que zero.`)
    }
    if (kitVariationId != null && c.component_product_variation_id === kitVariationId) {
      throw new Error('Um kit não pode conter ele mesmo.')
    }
    totals.set(c.component_product_variation_id, (totals.get(c.component_product_variation_id) ?? 0) + c.quantity)
  }
  return [...totals.entries()]
    .map(([component_product_variation_id, quantity]) => ({ component_product_variation_id, quantity }))
    .sort((a, b) => a.component_product_variation_id - b.component_product_variation_id)
}

/** ROUND(n, 2) com meio-para-cima decimal, igual ao NUMERIC do Postgres (1.005 → 1.01). */
function roundMoney(n: number): number {
  const v = Number(n) || 0
  return Number(Math.round(Number(`${v}e2`)) + 'e-2')
}
