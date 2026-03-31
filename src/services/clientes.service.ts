/**
 * Service de Clientes — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: validações de integridade (FK guards) e operações
 * de banco que envolvem múltiplas tabelas.
 *
 * As API routes importam daqui e apenas lidam com HTTP (parse, auth, response).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CustomerInput {
  name: string
  cpf?: string
  phone: string
  birth_date?: string | null
  city?: string | null
  state?: string | null
  origin?: 'instagram' | 'referral' | 'paid_traffic' | 'website' | 'store' | 'other' | null
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
 * Verifica se um cliente pode ser excluído com segurança.
 *
 * Regras:
 * 1. Não pode ter vendas vinculadas (sem ON DELETE CASCADE).
 * 2. Não pode ter transações de cashback vinculadas (sem ON DELETE CASCADE).
 *
 * customer_preferences, customer_metrics e customer_addresses têm ON DELETE CASCADE
 * e são removidos automaticamente pelo banco.
 */
export async function canDeleteCustomer(customerId: number): Promise<ServiceOutcome> {
  const admin = createAdminClient() // admin client: consultas de integridade referencial

  // Regra 1: vendas
  const { count: salesCount, error: salesError } = await admin
    .from('sales')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)

  if (salesError) return failure(salesError.message)

  if (salesCount && salesCount > 0) {
    return failure(
      `Cliente possui ${salesCount} venda(s) registrada(s) e não pode ser excluído.`,
      409
    )
  }

  // Regra 2: cashback
  const { count: cbCount, error: cbError } = await admin
    .from('cashback_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)

  if (cbError) return failure(cbError.message)

  if (cbCount && cbCount > 0) {
    return failure(
      `Cliente possui ${cbCount} transação(ões) de cashback e não pode ser excluído.`,
      409
    )
  }

  return success(undefined)
}

// ─── Snapshot para auditoria ──────────────────────────────────────────────────

/**
 * Retorna snapshot do cliente para auditoria (before/after).
 */
export async function getCustomerSnapshot(customerId: number): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('customers')
    .select('id, name, cpf, phone, city, active')
    .eq('id', customerId)
    .single() as unknown as { data: Record<string, unknown> | null }
  return data
}

// ─── Operações de escrita ─────────────────────────────────────────────────────

/**
 * Cria um novo cliente.
 * Retorna conflito (409) se CPF já existir.
 */
export async function createCustomer(
  input: CustomerInput & { cpf: string },
  createdBy: string,
  companyId: number | null
): Promise<ServiceOutcome<{ id: number | string }>> {
  const admin = createAdminClient() // admin client: INSERT em customers

  const { data, error } = await admin
    .from('customers')
    .insert({ ...input, created_by: createdBy, company_id: companyId } as any)
    .select('id')
    .single() as unknown as {
      data: { id: number | string } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const msg = error.code === '23505' ? 'CPF já cadastrado.' : error.message
    return failure(msg, error.code === '23505' ? 409 : 500)
  }

  return success(data!)
}

/**
 * Atualiza dados de um cliente existente.
 */
export async function updateCustomer(
  customerId: number,
  input: Partial<CustomerInput>
): Promise<ServiceOutcome> {
  const admin = createAdminClient() // admin client: UPDATE em customers

  const { error } = await (admin as any)
    .from('customers')
    .update(input)
    .eq('id', customerId) as { error: { message: string } | null }

  if (error) return failure(error.message)
  return success(undefined)
}
