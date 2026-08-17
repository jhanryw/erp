/**
 * Service de Clientes — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: validações de integridade (FK guards) e operações
 * de banco que envolvem múltiplas tabelas.
 *
 * As API routes importam daqui e apenas lidam com HTTP (parse, auth, response).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeE164BR } from '@/lib/utils/phone'
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

/**
 * FASE 1 (Customer Identity): `phone_e164` é calculado aqui, nunca confiado
 * ao chamador — mesmo padrão de "normalização central, não na UI" pedido no
 * relatório da Fase 1. Retorna `null` (nunca string vazia) quando o
 * telefone não pôde ser normalizado com segurança — `customers.phone`
 * continua gravado como veio, sem alteração; só a identidade canônica é
 * nova.
 */
function computePhoneE164(phone: string | null | undefined): string | null {
  if (!phone) return null
  const normalized = normalizeE164BR(phone)
  return normalized || null
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
export async function getCustomerSnapshot(customerId: number, companyId?: number | null): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  let query = admin
    .from('customers')
    .select('id, name, cpf, phone, city, active')
    .eq('id', customerId)
  if (companyId != null) query = (query as any).eq('company_id', companyId)
  const { data } = await (query as any).single() as unknown as { data: Record<string, unknown> | null }
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
): Promise<ServiceOutcome<{ id: number | string; name: string; cpf: string; phone: string }>> {
  const admin = createAdminClient() // admin client: INSERT em customers

  const { data, error } = await admin
    .from('customers')
    .insert({
      ...input,
      phone_e164: computePhoneE164(input.phone),
      created_by: createdBy,
      company_id: companyId,
    } as any)
    .select('id, name, cpf, phone')
    .single() as unknown as {
      data: { id: number | string; name: string; cpf: string; phone: string } | null
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
  input: Partial<CustomerInput>,
  companyId?: number | null
): Promise<ServiceOutcome> {
  const admin = createAdminClient() // admin client: UPDATE em customers

  const payload: Record<string, unknown> = { ...input }
  if ('phone' in input) payload.phone_e164 = computePhoneE164(input.phone)

  let query = (admin as any).from('customers').update(payload).eq('id', customerId)
  if (companyId != null) query = query.eq('company_id', companyId)

  const { error } = await query as { error: { message: string } | null }

  if (error) return failure(error.message)
  return success(undefined)
}
