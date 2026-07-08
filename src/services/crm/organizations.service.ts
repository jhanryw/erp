/**
 * Service de CRM — Organizações B2B (crm_organizations).
 *
 * Entidade de empresa-cliente, distinta de `companies` (tenant do ERP —
 * daí o nome `crm_organizations`, não `crm_companies`, para não colidir).
 * `tax_id` (CNPJ) é informativo — não é o cadastro fiscal autoritativo,
 * que continua em `customers`/módulo fiscal quando existir venda B2B real.
 *
 * Entrega 1 (Fase 3): só create/get/list.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmOrganization, CrmPersonCreatedSource } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmOrganizationInput {
  companyId: number
  name: string
  taxId?: string | null
  segment?: string | null
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

export async function createOrganization(input: CreateCrmOrganizationInput): Promise<ServiceOutcome<CrmOrganization>> {
  const name = input.name.trim()
  if (!name) return failure('Nome da organização é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_organizations')
    .insert({
      company_id: input.companyId,
      name,
      tax_id: input.taxId ?? null,
      segment: input.segment ?? null,
      notes: input.notes ?? null,
      created_source: input.createdSource,
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmOrganization | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data!)
}

export async function getOrganization(organizationId: number, companyId: number): Promise<ServiceOutcome<CrmOrganization>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_organizations')
    .select('*')
    .eq('id', organizationId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmOrganization | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Organização não encontrada.', 404)
  return success(data)
}

export async function listOrganizations(
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmOrganization[]>> {
  const admin = createAdminClient()
  let query = (admin as any).from('crm_organizations').select('*').eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmOrganization[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}
