/**
 * Service de Fornecedores — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: validações de integridade (FK guards) e operações
 * de banco que envolvem múltiplas tabelas.
 *
 * As API routes importam daqui e apenas lidam com HTTP (parse, auth, response).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SupplierInput {
  name: string
  document?: string | null
  phone?: string | null
  city?: string | null
  state?: string | null
  notes?: string | null
  active?: boolean
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

// ─── Verificação de integridade ───────────────────────────────────────────────

/**
 * Verifica se um fornecedor pode ser excluído com segurança.
 *
 * Regras:
 * 1. Não pode ter produtos vinculados (sem ON DELETE CASCADE).
 * 2. Não pode ter lotes de estoque vinculados (sem ON DELETE CASCADE).
 */
export async function canDeleteSupplier(supplierId: number): Promise<ServiceOutcome> {
  const admin = createAdminClient() // admin client: consultas de integridade referencial

  // Regra 1: produtos
  const { count: productsCount, error: productsError } = await admin
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)

  if (productsError) return failure(productsError.message)

  if (productsCount && productsCount > 0) {
    return failure(
      `Fornecedor possui ${productsCount} produto(s) cadastrado(s) e não pode ser excluído.`,
      409
    )
  }

  // Regra 2: lotes de estoque
  const { count: lotsCount, error: lotsError } = await admin
    .from('stock_lots')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)

  if (lotsError) return failure(lotsError.message)

  if (lotsCount && lotsCount > 0) {
    return failure(
      `Fornecedor possui ${lotsCount} entrada(s) de estoque e não pode ser excluído.`,
      409
    )
  }

  return success(undefined)
}

// ─── Snapshot para auditoria ──────────────────────────────────────────────────

/**
 * Retorna snapshot do fornecedor para auditoria (before/after).
 */
export async function getSupplierSnapshot(supplierId: number): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('suppliers')
    .select('id, name, document, active')
    .eq('id', supplierId)
    .single() as unknown as { data: Record<string, unknown> | null }
  return data
}

// ─── Operações de escrita ─────────────────────────────────────────────────────

/**
 * Cria um novo fornecedor.
 * Retorna conflito (409) se CNPJ/CPF já existir.
 */
export async function createSupplier(input: SupplierInput): Promise<ServiceOutcome<{ id: number }>> {
  const admin = createAdminClient() // admin client: INSERT em suppliers

  const { data, error } = await admin
    .from('suppliers')
    .insert(input as any)
    .select('id')
    .single() as unknown as {
      data: { id: number } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const msg = error.code === '23505' ? 'CNPJ/CPF já cadastrado.' : error.message
    return failure(msg, error.code === '23505' ? 409 : 500)
  }

  return success(data!)
}

/**
 * Atualiza dados de um fornecedor existente.
 */
export async function updateSupplier(
  supplierId: number,
  input: Partial<SupplierInput>
): Promise<ServiceOutcome> {
  const admin = createAdminClient() // admin client: UPDATE em suppliers

  const { error } = await (admin as any)
    .from('suppliers')
    .update({ ...input, state: input.state || null })
    .eq('id', supplierId) as { error: { code: string; message: string } | null }

  if (error) {
    const msg = error.code === '23505' ? 'CPF/CNPJ já cadastrado para outro fornecedor.' : error.message
    return failure(msg, error.code === '23505' ? 409 : 500)
  }

  return success(undefined)
}
