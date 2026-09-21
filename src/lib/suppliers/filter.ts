/**
 * Filtro por fornecedor das listagens do ERP (/produtos e /estoque).
 * Query param único: `?fornecedor=<suppliers.id>` — sempre o ID, nunca o nome.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const SUPPLIER_QUERY_PARAM = 'fornecedor'

export interface SupplierOption { id: number; name: string }

/** ID de fornecedor válido (inteiro positivo) ou `undefined` — qualquer outra coisa é ignorada (= "Todos"). */
export function parseSupplierFilter(raw: string | string[] | undefined | null): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined
  const id = Number(value)
  return id <= 2_147_483_647 ? id : undefined
}

/**
 * Fornecedores da empresa para o select: só ATIVOS (mesmo critério de GET /api/fornecedores,
 * que alimenta os outros selects), ordenados por nome. Sempre filtrado por `company_id`.
 */
export async function listSuppliersForFilter(admin: SupabaseClient, companyId: number): Promise<SupplierOption[]> {
  const { data, error } = await (admin as any)
    .from('suppliers')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('name', { ascending: true })
    .order('id', { ascending: true }) as { data: SupplierOption[] | null; error: { message: string } | null }
  if (error) throw new Error(`Falha ao listar fornecedores: ${error.message}`)
  return data ?? []
}
