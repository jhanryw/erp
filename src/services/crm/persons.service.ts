/**
 * Service de CRM — Pessoas (crm_persons).
 *
 * Identidade central do CRM. Sem CPF, sem endereço fiscal — isso pertence a
 * `customers` (Vendas/OMS/Fiscal), nunca duplicado aqui. Uma pessoa pode
 * existir no CRM sem nunca virar cliente; o vínculo com `customers`, quando
 * existir, vive em crm_person_customer_links (M:N), não nesta tabela.
 *
 * Entrega 1 (Fase 3): só create/get/list. Sem update/delete — soft-delete
 * (active=false) fica para quando houver um consumidor real (API/UI).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmPerson, CrmPersonCreatedSource } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmPersonInput {
  companyId: number
  displayName: string
  notes?: string | null
  createdSource: CrmPersonCreatedSource
  createdBy?: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

/**
 * Cria uma pessoa. `displayName` é obrigatório e não pode ser vazio —
 * diferente de `customers.name`, não há CPF/telefone exigido aqui.
 */
export async function createPerson(input: CreateCrmPersonInput): Promise<ServiceOutcome<CrmPerson>> {
  const displayName = input.displayName.trim()
  if (!displayName) return failure('Nome de exibição é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_persons')
    .insert({
      company_id: input.companyId,
      display_name: displayName,
      notes: input.notes ?? null,
      created_source: input.createdSource,
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmPerson | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data!)
}

/**
 * Busca uma pessoa por id, sempre escopada por company_id — mesmo padrão
 * de posse usado em brands/media (nenhuma leitura cross-empresa).
 */
export async function getPerson(personId: number, companyId: number): Promise<ServiceOutcome<CrmPerson>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_persons')
    .select('*')
    .eq('id', personId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmPerson | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Pessoa não encontrada.', 404)
  return success(data)
}

/**
 * Lista pessoas da empresa. `includeInactive` decide se soft-deletadas
 * (active=false) entram no resultado — default é só ativas.
 */
export async function listPersons(
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmPerson[]>> {
  const admin = createAdminClient()
  let query = (admin as any).from('crm_persons').select('*').eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmPerson[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}
