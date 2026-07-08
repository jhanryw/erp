/**
 * Service de CRM — Vínculo Pessoa↔Cliente (crm_person_customer_links).
 *
 * M:N entre crm_persons e customers, nunca 1:1 — cobre múltiplos cadastros
 * fiscais, duplicidade e fusão sem tabela extra: fundir dois clientes numa
 * pessoa é só marcar o link antigo active=false e criar um novo com
 * is_primary=true. `customers` nunca é lido/gravado por outro service de
 * CRM além deste — é o único ponto de contato entre os dois domínios.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmPersonCustomerLink, CrmPersonCustomerLinkMatchSource } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmPersonCustomerLinkInput {
  companyId: number
  personId: number
  customerId: number
  matchSource: CrmPersonCustomerLinkMatchSource
  isPrimary?: boolean
  createdBy?: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

function uniqueViolation(error: { code?: string; message: string }): { message: string; status: number } {
  if (error.code === '23505') {
    return { message: 'Já existe um vínculo ativo entre esta pessoa e este cliente (ou já existe um vínculo principal).', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Verificação de posse ─────────────────────────────────────────────────────

/**
 * Confirma que a pessoa (CRM) e o cliente (Vendas/OMS) pertencem à mesma
 * empresa antes de vincular. Não é impositível por FK simples entre
 * tabelas de domínios diferentes — mesmo padrão de entityBelongsToCompany().
 */
export async function personAndCustomerBelongToCompany(
  personId: number,
  customerId: number,
  companyId: number,
): Promise<boolean> {
  const admin = createAdminClient()

  const { data: person } = await admin
    .from('crm_persons')
    .select('id')
    .eq('id', personId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number } | null }

  const { data: customer } = await admin
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number } | null }

  return !!person && !!customer
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createPersonCustomerLink(
  input: CreateCrmPersonCustomerLinkInput,
): Promise<ServiceOutcome<CrmPersonCustomerLink>> {
  const belongs = await personAndCustomerBelongToCompany(input.personId, input.customerId, input.companyId)
  if (!belongs) return failure('Pessoa ou cliente não pertencem a esta empresa.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_person_customer_links')
    .insert({
      company_id: input.companyId,
      person_id: input.personId,
      customer_id: input.customerId,
      match_source: input.matchSource,
      is_primary: input.isPrimary ?? false,
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmPersonCustomerLink | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function getPersonCustomerLink(
  linkId: number,
  companyId: number,
): Promise<ServiceOutcome<CrmPersonCustomerLink>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_person_customer_links')
    .select('*')
    .eq('id', linkId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmPersonCustomerLink | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Vínculo não encontrado.', 404)
  return success(data)
}

export async function listPersonCustomerLinksByPerson(
  personId: number,
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmPersonCustomerLink[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_person_customer_links')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmPersonCustomerLink[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

export async function listPersonCustomerLinksByCustomer(
  customerId: number,
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmPersonCustomerLink[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_person_customer_links')
    .select('*')
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmPersonCustomerLink[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}
