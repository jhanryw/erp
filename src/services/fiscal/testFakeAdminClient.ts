/**
 * Fake in-memory do client admin do Supabase, só pra testes de
 * `submitNfeHomologacao`/`consultNfeStatus` — cobre exatamente os padrões
 * de chamada usados nesses arquivos (select+eq*+order+limit+maybeSingle,
 * insert+select+single com verificação de UNIQUE(provider,provider_ref),
 * update via `.then` thenable, delete, insert de array). Não é um mock
 * genérico de Supabase — não tentar reaproveitar fora deste escopo.
 *
 * Não é um arquivo `*.test.ts` — é importado pelos testes.
 */

import { vi } from 'vitest'

export function createFakeAdmin(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    fiscal_documents: [],
    fiscal_document_items: [],
    company_fiscal_settings: [],
    ...seed,
  }
  let nextId = 1000

  function matchesFilters(row: any, filters: Array<[string, any]>) {
    return filters.every(([col, val]) => row[col] === val)
  }

  function builder(table: string) {
    const filters: Array<[string, any]> = []
    let orderDesc = false
    let limitN: number | null = null
    let pendingInsert: any = null
    let pendingUpdate: any = null
    let pendingDelete = false

    function applyFilters() {
      let rows = (tables[table] ?? []).filter((r) => matchesFilters(r, filters))
      if (orderDesc) rows = [...rows].sort((a, b) => b.id - a.id)
      if (limitN != null) rows = rows.slice(0, limitN)
      return rows
    }

    const api: any = {
      select() { return api },
      eq(col: string, val: any) { filters.push([col, val]); return api },
      order() { orderDesc = true; return api },
      limit(n: number) { limitN = n; return api },
      insert(obj: any) { pendingInsert = obj; return api },
      update(obj: any) { pendingUpdate = obj; return api },
      delete() { pendingDelete = true; return api },
      async maybeSingle() {
        const rows = applyFilters()
        return { data: rows[0] ?? null, error: null }
      },
      async single() {
        if (pendingInsert && !Array.isArray(pendingInsert)) {
          if (table === 'fiscal_documents') {
            const dup = tables.fiscal_documents.find((r) => r.provider === pendingInsert.provider && r.provider_ref === pendingInsert.provider_ref)
            if (dup) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          const row = { id: nextId++, created_at: new Date(nextId).toISOString(), ...pendingInsert }
          tables[table].push(row)
          return { data: row, error: null }
        }
        const rows = applyFilters()
        return { data: rows[0] ?? null, error: null }
      },
      then(resolve: (v: any) => void) {
        if (pendingUpdate) {
          const rows = applyFilters()
          rows.forEach((r) => Object.assign(r, pendingUpdate))
          resolve({ error: null, data: rows })
          return
        }
        if (pendingDelete) {
          tables[table] = (tables[table] ?? []).filter((r) => !matchesFilters(r, filters))
          resolve({ error: null })
          return
        }
        if (Array.isArray(pendingInsert)) {
          pendingInsert.forEach((obj) => tables[table].push({ id: nextId++, ...obj }))
          resolve({ error: null })
          return
        }
        resolve({ data: applyFilters(), error: null })
      },
    }

    return api
  }

  return {
    client: { from: builder } as any,
    tables,
    seedFiscalDocument(row: Partial<Record<string, any>>) {
      const full = { id: nextId++, created_at: new Date(nextId).toISOString(), ...row }
      tables.fiscal_documents.push(full)
      return full
    },
  }
}

export function mockCreateAdminClient(fake: ReturnType<typeof createFakeAdmin>) {
  return vi.fn().mockReturnValue(fake.client)
}
