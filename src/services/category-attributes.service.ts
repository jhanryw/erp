/**
 * Service de Governança Categoria ↔ Atributos — lógica de negócio
 * desacoplada de HTTP.
 *
 * category_attributes não tem company_id próprio — o escopo de empresa
 * vem de categories.company_id (variation_type_id é global). Toda leitura
 * e escrita precisa confirmar posse via join com categories.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CategoryAttributeInput {
  category_id: number
  variation_type_id: number
  required?: boolean
  active?: boolean
}

export interface CategoryAttribute {
  id: number
  category_id: number
  required: boolean
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
    return { message: 'Este atributo já está vinculado a esta categoria.', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Verificação de posse ─────────────────────────────────────────────────────

/**
 * Confirma que a categoria pertence à empresa do usuário.
 * Necessário antes de criar um vínculo — category_attributes não tem
 * company_id próprio.
 */
export async function categoryBelongsToCompany(categoryId: number, companyId: number): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('categories')
    .select('id')
    .eq('id', categoryId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number } | null }
  return !!data
}

// ─── Snapshot para auditoria / verificação de posse ───────────────────────────

/**
 * Retorna snapshot do vínculo (before/after para auditoria), confirmando
 * posse via join com categories.company_id. Usado também como checagem
 * de "existe e pertence à empresa" antes de qualquer mutação.
 */
export async function getCategoryAttributeSnapshot(
  id: number,
  companyId: number,
): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('category_attributes')
    .select('id, category_id, variation_type_id, required, active, categories!inner(company_id)')
    .eq('id', id)
    .eq('categories.company_id', companyId)
    .maybeSingle() as unknown as { data: Record<string, unknown> | null }

  if (!data) return null
  const { categories: _categories, ...rest } = data as Record<string, unknown>
  return rest
}

// ─── Operações de escrita ─────────────────────────────────────────────────────

/**
 * Cria um novo vínculo categoria↔atributo.
 * Retorna 404 se a categoria não pertence à empresa; 409 em duplicidade
 * de (category_id, variation_type_id).
 */
export async function createCategoryAttribute(
  input: CategoryAttributeInput,
  companyId: number,
): Promise<ServiceOutcome<CategoryAttribute>> {
  const belongs = await categoryBelongsToCompany(input.category_id, companyId)
  if (!belongs) return failure('Categoria não encontrada.', 404)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('category_attributes')
    .insert({
      category_id:       input.category_id,
      variation_type_id: input.variation_type_id,
      required:          input.required ?? false,
      active:            input.active ?? true,
    } as any)
    .select('id, category_id, required, active')
    .single() as unknown as {
      data: CategoryAttribute | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }

  return success(data!)
}

/**
 * Atualiza um vínculo — merge parcial (required/active). Reativação via
 * { active: true }. Confirma posse via companyId antes de atualizar.
 */
export async function updateCategoryAttribute(
  id: number,
  input: Partial<Pick<CategoryAttributeInput, 'required' | 'active'>>,
  companyId: number,
): Promise<ServiceOutcome> {
  const before = await getCategoryAttributeSnapshot(id, companyId)
  if (!before) return failure('Vínculo não encontrado.', 404)

  const patch: Record<string, unknown> = {}
  if (input.required !== undefined) patch.required = input.required
  if (input.active   !== undefined) patch.active   = input.active

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('category_attributes')
    .update(patch)
    .eq('id', id) as { error: { code: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }

  return success(undefined)
}

/**
 * Soft-delete: active = false. Nunca exclui fisicamente.
 * Confirma posse via companyId antes de desativar.
 */
export async function deactivateCategoryAttribute(id: number, companyId: number): Promise<ServiceOutcome> {
  const before = await getCategoryAttributeSnapshot(id, companyId)
  if (!before) return failure('Vínculo não encontrado.', 404)

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('category_attributes')
    .update({ active: false })
    .eq('id', id) as { error: { code: string; message: string } | null }

  if (error) return failure(error.message)

  return success(undefined)
}
