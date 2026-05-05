export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'

// ─── Types ───────────────────────────────────────────────────────────────────

type GoalRow = {
  month: number
  goal_min: number
  goal_target: number
  goal_stretch: number
}

// monthly_sales_goals não está nos tipos gerados do Supabase ainda
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const goalsTable = (client: ReturnType<typeof createAdminClient>) => (client as any).from('monthly_sales_goals')

// ─── Schemas ─────────────────────────────────────────────────────────────────

const monthGoalSchema = z.object({
  month: z.number().int().min(1).max(12),
  goal_min: z.number().min(0),
  goal_target: z.number().min(0),
  goal_stretch: z.number().min(0),
})

const postSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  goals: z.array(monthGoalSchema).min(1).max(12),
})

// ─── GET /api/sales-goals?year=YYYY ──────────────────────────────────────────

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const { searchParams } = new URL(request.url)
  const yearParam = searchParams.get('year')
  const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear()

  if (isNaN(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'Ano inválido.' }, { status: 400 })
  }

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data, error } = await goalsTable(admin)
    .select('month, goal_min, goal_target, goal_stretch')
    .eq('company_id', user.company_id)
    .eq('year', year)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Garante retorno dos 12 meses, preenchendo ausentes com zeros
  const stored = new Map((data as GoalRow[] ?? []).map((r) => [r.month, r]))
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    const saved = stored.get(m)
    return {
      month: m,
      goal_min: saved ? Number(saved.goal_min) : 0,
      goal_target: saved ? Number(saved.goal_target) : 0,
      goal_stretch: saved ? Number(saved.goal_stretch) : 0,
    }
  })

  return NextResponse.json({ year, months })
}

// ─── POST /api/sales-goals ────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { year, goals } = parsed.data
  const admin = createAdminClient()

  const rows = goals.map((g) => ({
    company_id: user.company_id as number,
    year,
    month: g.month,
    goal_min: g.goal_min,
    goal_target: g.goal_target,
    goal_stretch: g.goal_stretch,
  }))

  const { error } = await goalsTable(admin)
    .upsert(rows, { onConflict: 'company_id,year,month' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({
    userId: user.id,
    userRole: user.role,
    action: 'update',
    resource: 'monthly_sales_goals',
    detail: `year:${year} months:${goals.map((g) => g.month).join(',')}`,
  })

  return NextResponse.json({ ok: true }, { status: 200 })
}
