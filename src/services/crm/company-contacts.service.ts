/**
 * Service de CRM — Contatos de Organização (crm_company_contacts).
 *
 * FK explícita pessoa↔organização (não entity_type/entity_id — decisão
 * arquitetural do núcleo do CRM). `is_primary` segue o mesmo padrão de
 * "no máximo um por dono" já usado em media_usages/crm_person_customer_links
 * via índice único parcial; nenhuma troca atômica (RPC) ainda — Entrega 1
 * só cria, não troca primary.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmCompanyContact } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmCompanyContactInput {
  companyId: number
  organizationId: number
  personId: number
  role?: string | null
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
    return { message: 'Esta pessoa já é contato ativo desta organização (ou já existe um contato principal).', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Verificação de posse ─────────────────────────────────────────────────────

/**
 * Confirma que organização e pessoa pertencem à mesma empresa antes de
 * vincular — não é impositível por FK simples entre tabelas diferentes,
 * mesmo padrão de categoryBelongsToCompany()/entityBelongsToCompany().
 */
export async function organizationAndPersonBelongToCompany(
  organizationId: number,
  personId: number,
  companyId: number,
): Promise<boolean> {
  const admin = createAdminClient()

  const { data: org } = await admin
    .from('crm_organizations')
    .select('id')
    .eq('id', organizationId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number } | null }

  const { data: person } = await admin
    .from('crm_persons')
    .select('id')
    .eq('id', personId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number } | null }

  return !!org && !!person
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createCompanyContact(
  input: CreateCrmCompanyContactInput,
): Promise<ServiceOutcome<CrmCompanyContact>> {
  const belongs = await organizationAndPersonBelongToCompany(input.organizationId, input.personId, input.companyId)
  if (!belongs) return failure('Organização ou pessoa não pertencem a esta empresa.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_company_contacts')
    .insert({
      company_id: input.companyId,
      organization_id: input.organizationId,
      person_id: input.personId,
      role: input.role ?? null,
      is_primary: input.isPrimary ?? false,
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmCompanyContact | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function getCompanyContact(contactId: number, companyId: number): Promise<ServiceOutcome<CrmCompanyContact>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_company_contacts')
    .select('*')
    .eq('id', contactId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmCompanyContact | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Contato não encontrado.', 404)
  return success(data)
}

export async function listCompanyContactsByOrganization(
  organizationId: number,
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmCompanyContact[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_company_contacts')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmCompanyContact[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

export async function listCompanyContactsByPerson(
  personId: number,
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmCompanyContact[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_company_contacts')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmCompanyContact[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}
