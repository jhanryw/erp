export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'
import { createCategoryAttribute } from '@/services/category-attributes.service'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { z } from 'zod'

const postSchema = z.object({
  category_id:       z.coerce.number().int().positive(),
  variation_type_id: z.coerce.number().int().positive(),
  required:          z.boolean().default(false),
  active:            z.boolean().default(true),
})

// ─── GET /api/category-attributes ─────────────────────────────────────────────
// Lista vínculos da empresa (via join com categories.company_id, já que
// category_attributes não tem company_id próprio).
// Filtros opcionais: ?category_id=&active=true|false — sem `active`,
// retorna todos (ativos e inativos).

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)
  const categoryIdParam = searchParams.get('category_id')
  const activeParam = searchParams.get('active')

  if (categoryIdParam) {
    const categoryId = Number(categoryIdParam)
    if (!Number.isFinite(categoryId) || categoryId <= 0) return err('category_id inválido', 400)
  }

  const admin = createAdminClient()
  let query = admin
    .from('category_attributes')
    .select(`
      id, category_id, required, active,
      categories!inner(company_id),
      variation_type:variation_type_id (id, name, slug, kind)
    `)
    .eq('categories.company_id', user.company_id)
    .order('id')

  if (categoryIdParam) query = query.eq('category_id', Number(categoryIdParam)) as typeof query
  if (activeParam === 'true') query = query.eq('active', true) as typeof query
  if (activeParam === 'false') query = query.eq('active', false) as typeof query

  const { data, error } = await query
  if (error) return err(error.message)

  const items = ((data ?? []) as any[]).map(({ categories: _categories, ...rest }) => rest)

  return ok({ category_attributes: items })
}

// ─── POST /api/category-attributes ────────────────────────────────────────────

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try { body = await request.json() } catch { return err('JSON inválido.', 400) }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const result = await createCategoryAttribute(parsed.data, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'category_attribute',
    resourceId: result.data.id,
    detail: `category_id=${result.data.category_id}`,
  })

  return ok({ category_attribute: result.data }, 201)
}
