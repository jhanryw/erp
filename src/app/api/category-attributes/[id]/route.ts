export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'
import {
  getCategoryAttributeSnapshot,
  updateCategoryAttribute,
  deactivateCategoryAttribute,
} from '@/services/category-attributes.service'
import { ok, err, notFound, forbidden, validationError } from '@/lib/api/response'
import { z } from 'zod'

const putSchema = z.object({
  required: z.boolean().optional(),
  active:   z.boolean().optional(),
})

function parseId(id: string) {
  const n = Number(id)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ─── GET /api/category-attributes/[id] ───────────────────────────────────────
// Verifica posse via join com categories.company_id e resolve variation_type.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const id = parseId(params.id)
  if (!id) return err('ID inválido', 400)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('category_attributes')
    .select(`
      id, category_id, required, active,
      categories!inner(company_id),
      variation_type:variation_type_id (id, name, slug, kind)
    `)
    .eq('id', id)
    .eq('categories.company_id', user.company_id)
    .single() as unknown as { data: any; error: any }

  if (error || !data) return notFound('Vínculo categoria/atributo')

  const { categories: _categories, ...rest } = data
  return ok({ category_attribute: rest })
}

// ─── PUT /api/category-attributes/[id] ───────────────────────────────────────
// Parcial: required/active. Reativação: { active: true }.

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const id = parseId(params.id)
  if (!id) return err('ID inválido', 400)

  let body: unknown
  try { body = await request.json() } catch { return err('JSON inválido', 400) }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const before = await getCategoryAttributeSnapshot(id, user.company_id)
  if (!before) return notFound('Vínculo categoria/atributo')

  const result = await updateCategoryAttribute(id, parsed.data, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  const after = await getCategoryAttributeSnapshot(id, user.company_id)
  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'category_attribute', resourceId: id,
    before: before ?? undefined, after: after ?? undefined,
  })

  return ok({ ok: true })
}

// ─── DELETE /api/category-attributes/[id] ────────────────────────────────────
// Soft-delete: active = false. Nunca exclui fisicamente.

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const id = parseId(params.id)
  if (!id) return err('ID inválido', 400)

  const before = await getCategoryAttributeSnapshot(id, user.company_id)
  if (!before) return notFound('Vínculo categoria/atributo')

  const result = await deactivateCategoryAttribute(id, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'category_attribute', resourceId: id,
    before: before ?? undefined,
  })

  return ok({ ok: true })
}
