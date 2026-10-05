/** Fake mínimo de PostgREST p/ testes de SKU/produtos (eq/like/ilike/in/single/insert/update/delete + embed !inner de type_attribute_values). */
export type Row = Record<string, any>
export type Tables = Record<string, Row[]>

/** Fake mínimo de PostgREST: eq/like/in/single/maybeSingle/insert/update/delete + embed !inner de type_attribute_values. */
export function fakeAdmin(tables: Tables) {
  let nextId = 1000
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Row | null = null
      let single = false
      const q: any = {
        select() { return q },
        insert(v: Row) { mode = 'insert'; payload = v; return q },
        update(v: Row) { mode = 'update'; payload = v; return q },
        delete() { mode = 'delete'; return q },
        eq(col: string, val: unknown) {
          if (!col.includes('.')) filters.push(r => r[col] === val)
          return q
        },
        ilike(col: string, pat: string) { const n = pat.replace(/%/g, '').toLowerCase(); filters.push(r => String(r[col] ?? '').toLowerCase() === n || String(r[col] ?? '').toLowerCase().includes(n)); return q },
        in(col: string, vals: unknown[]) { filters.push(r => vals.includes(r[col])); return q },
        like(col: string, pat: string) { const p = pat.replace(/%$/, ''); filters.push(r => String(r[col]).startsWith(p)); return q },
        order() { return q },
        single() { single = true; return q },
        maybeSingle() { single = true; return q },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      function run() {
        tables[table] ??= []
        if (mode === 'insert') {
          const rows = Array.isArray(payload) ? payload : [payload!]
          const out = rows.map(r => ({ id: nextId++, ...r }))
          tables[table].push(...out)
          return { data: single ? out[0] : out, error: null }
        }
        const rows = tables[table].filter(r => filters.every(f => f(r)))
        if (mode === 'update') { rows.forEach(r => Object.assign(r, payload)); return { data: rows, error: null } }
        if (mode === 'delete') { tables[table] = tables[table].filter(r => !rows.includes(r)); return { data: null, error: null } }
        let out: Row[] = rows
        if (table === 'type_attribute_values') {
          out = rows.map(r => ({ ...r, variation_values: tables.variation_values.find(v => v.id === r.variation_value_id) }))
            .filter(r => r.variation_values?.active)
        }
        return { data: single ? (out[0] ?? null) : out, error: null }
      }
      return q
    },
    rpc: async () => ({ data: null, error: null }),
  }
}

