export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'
import { getBrandSnapshot, updateBrand, deactivateBrand } from '@/services/marcas.service'
import { ok, err, notFound, forbidden, validationError } from '@/lib/api/response'
import { z } from 'zod'

const putSchema = z.object({
  name:   z.string().min(2).max(100).optional(),
  slug:   z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
})

function parseId(id: string) {
  const n = Number(id)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ─── GET /api/marcas/[id] ─────────────────────────────────────────────────────

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const brandId = parseId(params.id)
  if (!brandId) return err('ID inválido', 400)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('brands')
    .select('id, name, slug, active')
    .eq('id', brandId)
    .eq('company_id', user.company_id)
    .single() as unknown as { data: Record<string, unknown> | null; error: any }

  if (error || !data) return notFound('Marca')
  return ok({ brand: data })
}

// ─── PUT /api/marcas/[id] ─────────────────────────────────────────────────────
// Parcial: só atualiza os campos enviados. Reativação: { active: true }.

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const brandId = parseId(params.id)
  if (!brandId) return err('ID inválido', 400)

  let body: unknown
  try { body = await request.json() } catch { return err('JSON inválido', 400) }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const before = await getBrandSnapshot(brandId, user.company_id)
  if (!before) return notFound('Marca')

  const result = await updateBrand(brandId, parsed.data, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  const after = await getBrandSnapshot(brandId, user.company_id)
  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'brand', resourceId: brandId,
    before: before ?? undefined, after: after ?? undefined,
  })

  return ok({ ok: true })
}

// ─── DELETE /api/marcas/[id] ──────────────────────────────────────────────────
// Soft-delete: marca active = false. Nunca exclui fisicamente.

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const brandId = parseId(params.id)
  if (!brandId) return err('ID inválido', 400)

  const before = await getBrandSnapshot(brandId, user.company_id)
  if (!before) return notFound('Marca')

  const result = await deactivateBrand(brandId, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'brand', resourceId: brandId,
    before: before ?? undefined,
  })

  return ok({ ok: true })
}
