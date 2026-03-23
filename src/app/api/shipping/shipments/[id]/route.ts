export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json()
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('shipments')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', Number(params.id))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
