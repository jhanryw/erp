/**
 * Service de Marcas — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: geração/normalização de slug e operações de escrita.
 * As API routes importam daqui e apenas lidam com HTTP (parse, auth, response).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { toSlug } from '@/lib/utils/slug'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface BrandInput {
  name: string
  slug?: string
  active?: boolean
}

export interface Brand {
  id: number
  name: string
  slug: string
  active: boolean
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

function uniqueViolation(error: { code: string; message: string }): { message: string; status: number } {
  if (error.code === '23505') {
    return { message: 'Já existe uma marca com este nome/slug nesta empresa.', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Snapshot para auditoria ──────────────────────────────────────────────────

/**
 * Retorna snapshot da marca para auditoria (before/after).
 */
export async function getBrandSnapshot(brandId: number, companyId?: number | null): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  let query = admin.from('brands').select('id, name, slug, active').eq('id', brandId)
  if (companyId != null) query = (query as any).eq('company_id', companyId)
  const { data } = await (query as any).single() as unknown as { data: Record<string, unknown> | null }
  return data
}

// ─── Operações de escrita ─────────────────────────────────────────────────────

/**
 * Cria uma nova marca.
 * Gera slug a partir do nome quando não informado; normaliza o slug quando
 * informado. Retorna 409 em colisão de (company_id, slug).
 */
export async function createBrand(input: BrandInput, companyId: number | null): Promise<ServiceOutcome<Brand>> {
  const admin = createAdminClient()

  const slug = toSlug(input.slug || input.name)
  if (!slug) return failure('Não foi possível gerar um slug válido a partir do nome.', 422)

  const { data, error } = await admin
    .from('brands')
    .insert({ name: input.name, slug, active: input.active ?? true, company_id: companyId } as any)
    .select('id, name, slug, active')
    .single() as unknown as {
      data: Brand | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }

  return success(data!)
}

/**
 * Atualiza uma marca — merge parcial, só altera campos enviados.
 * Reativação é feita enviando { active: true }.
 */
export async function updateBrand(
  brandId: number,
  input: Partial<BrandInput>,
  companyId?: number | null,
): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.slug !== undefined) patch.slug = toSlug(input.slug)
  if (input.active !== undefined) patch.active = input.active

  let query = (admin as any).from('brands').update(patch).eq('id', brandId)
  if (companyId != null) query = query.eq('company_id', companyId)

  const { error } = await query as { error: { code: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }

  return success(undefined)
}

/**
 * Soft-delete: marca active = false. Nunca exclui fisicamente.
 * Reativação é feita via updateBrand com { active: true }.
 */
export async function deactivateBrand(brandId: number, companyId?: number | null): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  let query = (admin as any).from('brands').update({ active: false }).eq('id', brandId)
  if (companyId != null) query = query.eq('company_id', companyId)

  const { error } = await query as { error: { code: string; message: string } | null }
  if (error) return failure(error.message)

  return success(undefined)
}
