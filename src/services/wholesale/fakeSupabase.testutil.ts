/**
 * Fake em memória do client Supabase (service role) — só para testes do
 * catálogo de atacado. Reproduz o que importa pro comportamento testado:
 *   - .eq/.in/.ilike, .order, .range, .limit, .maybeSingle;
 *   - LIMITE DE LINHAS do PostgREST (`maxRows`, default 1000) aplicado depois
 *     de .range — sem .range() um resultado grande é truncado, como em produção;
 *   - embeds (`alias:fk(...)`, `tabela!inner(...)`) e a semântica REAL do
 *     PostgREST para filtro em embed: com `!inner` a linha-pai é removida;
 *     sem `!inner` só o objeto embutido vira null e a linha-pai PERMANECE.
 */

type Row = Record<string, any>
export type FakeTables = Record<string, Row[]>

/** embed → { tabela alvo, coluna FK no pai }, por tabela pai. */
const RELATIONS: Record<string, Record<string, { table: string; fk: string }>> = {
  products: { suppliers: { table: 'suppliers', fk: 'supplier_id' }, brands: { table: 'brands', fk: 'brand_id' }, categories: { table: 'categories', fk: 'category_id' } },
  media_usages: { media: { table: 'media', fk: 'media_id' } },
  product_variations: { products: { table: 'products', fk: 'product_id' } },
  stock_balances: { stock_locations: { table: 'stock_locations', fk: 'stock_location_id' } },
  product_variation_attributes: {
    variation_types: { table: 'variation_types', fk: 'variation_type_id' },
    variation_values: { table: 'variation_values', fk: 'variation_value_id' },
  },
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

interface Embed { name: string; inner: boolean }

function parseEmbeds(select: string): Embed[] {
  const embeds: Embed[] = []
  for (const token of splitTopLevel(select)) {
    const m = token.match(/^(?:(\w+):(\w+)|(\w+))(!inner)?\(/)
    if (!m) continue
    embeds.push({ name: (m[1] ?? m[3]) as string, inner: !!m[4] })
  }
  return embeds
}

export interface FakeAdminOptions {
  maxRows?: number
  /** Emulação de RPC (Postgres) — recebe o nome, os args e as tabelas em memória. */
  rpc?: (name: string, args: any, tables: FakeTables) => { data: any; error: { message: string } | null }
}

export interface FakeAdmin {
  from: (table: string) => any
  rpc: (name: string, args: any) => Promise<{ data: any; error: { message: string } | null }>
  /** Quantas consultas foram feitas por tabela — pra provar ausência de N+1. */
  queryCount: Record<string, number>
}

export function createFakeAdmin(tables: FakeTables, options: FakeAdminOptions = {}): FakeAdmin {
  const maxRows = options.maxRows ?? 1000
  const queryCount: Record<string, number> = {}

  function from(table: string) {
    queryCount[table] = (queryCount[table] ?? 0) + 1
    let embeds: Embed[] = []
    const filters: ((row: Row) => boolean)[] = []
    const embedFilters: { embed: string; field: string; value: unknown }[] = []
    const orders: { col: string; asc: boolean }[] = []
    let updateValues: Row | null = null
    let rangeFrom = 0
    let rangeTo = Number.POSITIVE_INFINITY

    const q: any = {
      select(cols: string, _opts?: { count?: string }) { embeds = parseEmbeds(cols); return q },
      or(expr: string) {
        // suporta apenas `col.ilike.%x%,col2.ilike.%x%`
        const conds = expr.split(',').map((c) => { const [col, , pat] = c.split('.'); return { col, needle: (pat ?? '').replace(/%/g, '').toLowerCase() } })
        filters.push((r) => conds.some((c) => String(r[c.col] ?? '').toLowerCase().includes(c.needle)))
        return q
      },
      update(values: Row) { updateValues = values; return q },
      eq(col: string, value: unknown) {
        if (col.includes('.')) { const [embed, field] = col.split('.'); embedFilters.push({ embed, field, value }) }
        else filters.push((r) => r[col] === value)
        return q
      },
      in(col: string, values: unknown[]) { filters.push((r) => values.includes(r[col])); return q },
      ilike(col: string, pattern: string) {
        const needle = pattern.replace(/%/g, '').toLowerCase()
        filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
        return q
      },
      order(col: string, opts?: { ascending?: boolean }) { orders.push({ col, asc: opts?.ascending !== false }); return q },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return q },
      limit(n: number) { rangeFrom = 0; rangeTo = n - 1; return q },
      maybeSingle() { q._single = true; return q },
      _single: false,
      then(resolve: (v: { data: any; error: null; count?: number }) => unknown, reject?: (e: unknown) => unknown) {
        try { return Promise.resolve(run()).then(resolve, reject) } catch (e) { return Promise.reject(e).then(resolve, reject) }
      },
    }

    function attachEmbeds(row: Row): Row | null {
      const out: Row = { ...row }
      for (const embed of embeds) {
        const rel = RELATIONS[table]?.[embed.name]
        if (!rel) continue
        let related: Row | null = (tables[rel.table] ?? []).find((r) => r.id === row[rel.fk]) ?? null
        const efs = embedFilters.filter((f) => f.embed === embed.name)
        const matches = related != null && efs.every((f) => related![f.field] === f.value)
        if (efs.length > 0 && !matches) {
          if (embed.inner) return null // PostgREST: !inner remove a linha-pai
          related = null // sem !inner: só o embed vira null, o pai permanece
        }
        if (embed.inner && related == null) return null
        out[embed.name] = related
      }
      return out
    }

    function run() {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (updateValues) {
        for (const r of rows) Object.assign(r, updateValues)
        return { data: rows.map((r) => ({ ...r })), error: null }
      }
      rows = rows.map(attachEmbeds).filter((r): r is Row => r != null)
      for (const { col, asc } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1)))
      }
      const page = rows.slice(rangeFrom, Math.min(rangeTo + 1, rangeFrom + maxRows))
      return { data: q._single ? (page[0] ?? null) : page, error: null, count: rows.length }
    }
    return q
  }

  const rpc = async (name: string, args: any) => {
    queryCount[`rpc:${name}`] = (queryCount[`rpc:${name}`] ?? 0) + 1
    return options.rpc ? options.rpc(name, args, tables) : { data: null, error: { message: 'rpc não emulada' } }
  }

  return { from, rpc, queryCount }
}

/**
 * Emulação em memória de `rpc_create_wholesale_order` (mesma semântica da RPC
 * SQL: idempotência por empresa+chave, contador por empresa, limite anti-spam,
 * mínimo e TUDO-OU-NADA). A atomicidade REAL é garantida/testada no Postgres
 * (supabase/tests/wholesale_orders.test.sql) — aqui só se exercita a
 * orquestração do TypeScript. `failOnItemIndex` simula falha ao gravar um item.
 */
export function createOrdersRpc(opts: { failOnItemIndex?: number } = {}) {
  return (name: string, a: any, tables: FakeTables) => {
    if (name !== 'rpc_create_wholesale_order') return { data: null, error: { message: `rpc desconhecida: ${name}` } }
    tables.wholesale_orders ??= []
    tables.wholesale_order_items ??= []
    tables.wholesale_order_counters ??= []

    const existing = tables.wholesale_orders.find((o) => o.company_id === a.p_company_id && o.idempotency_key === a.p_idempotency_key)
    if (existing) return { data: { ok: true, order_id: existing.id, code: existing.code, replay: true }, error: null }

    const items: any[] = a.p_items
    const totalItems = items.reduce((s, i) => s + i.quantity, 0)
    const subtotal = Math.round(items.reduce((s, i) => s + Math.round(i.unit_price * 100) * i.quantity, 0)) / 100
    if (subtotal < a.p_minimum_order_amount) return { data: { ok: false, error: 'below_minimum' }, error: null }

    const recent = tables.wholesale_orders.filter((o) => o.company_id === a.p_company_id)
    if (a.p_request_ip_hash && recent.filter((o) => o.request_ip_hash === a.p_request_ip_hash).length >= a.p_max_per_ip_hour) return { data: { ok: false, error: 'rate_limited' }, error: null }
    if (recent.filter((o) => o.customer_phone === a.p_customer_phone).length >= a.p_max_per_phone_hour) return { data: { ok: false, error: 'rate_limited' }, error: null }
    if (recent.length >= (a.p_max_per_company_hour ?? Infinity)) return { data: { ok: false, error: 'rate_limited' }, error: null }

    // Tudo-ou-nada: monta em memória e só grava se nenhum item falhar.
    const counter = tables.wholesale_order_counters.find((c) => c.company_id === a.p_company_id) ?? { company_id: a.p_company_id, last_number: 0 }
    const number = counter.last_number + 1
    const id = `00000000-0000-4000-8000-${String(tables.wholesale_orders.length + 1).padStart(12, '0')}`
    const code = `AT-${String(number).padStart(6, '0')}`
    const rows: any[] = []
    for (let i = 0; i < items.length; i++) {
      if (opts.failOnItemIndex === i) return { data: null, error: { message: 'falha simulada ao gravar item' } }
      rows.push({ order_id: id, company_id: a.p_company_id, position: i + 1, variation_id: items[i].variation_id, product_id: items[i].product_id,
        product_name: items[i].product_name, sku: items[i].sku, attributes: items[i].attributes, quantity: items[i].quantity,
        unit_price: items[i].unit_price, subtotal: Math.round(items[i].unit_price * 100) * items[i].quantity / 100 })
    }
    if (!tables.wholesale_order_counters.includes(counter)) tables.wholesale_order_counters.push(counter)
    counter.last_number = number
    tables.wholesale_orders.push({
      id, company_id: a.p_company_id, order_number: number, code, status: 'pending', customer_name: a.p_customer_name, customer_phone: a.p_customer_phone,
      total_items: totalItems, subtotal, minimum_order_amount: a.p_minimum_order_amount, idempotency_key: a.p_idempotency_key,
      request_ip_hash: a.p_request_ip_hash, sale_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    tables.wholesale_order_items.push(...rows)
    return { data: { ok: true, order_id: id, code, replay: false }, error: null }
  }
}
