export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  document: z.preprocess(n, z.string().nullable().optional()),
  phone: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  state: z.preprocess(n, z.string().nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
  active: z.boolean().default(true),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient()
  const { data, error } = (await admin.from('suppliers').select('*').eq('id', Number(params.id)).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Fornecedor não encontrado' }, { status: 404 })
  return NextResponse.json({ supplier: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('suppliers').update({ ...parsed.data, state: parsed.data.state || null }).eq('id', Number(params.id))) as { error: any }
  if (error) {
    const msg = error.code === '23505' ? 'CPF/CNPJ já cadastrado para outro fornecedor.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  // Exclusão de fornecedor com verificação de dependências — exige admin
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  const supplierId = Number(params.id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Bloquear se houver produtos vinculados (sem CASCADE)
  const { count: productsCount, error: productsError } = await admin
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)

  if (productsError) return NextResponse.json({ error: productsError.message }, { status: 500 })

  if (productsCount && productsCount > 0) {
    return NextResponse.json(
      { error: 'Fornecedor possui produtos cadastrados e não pode ser excluído.' },
      { status: 409 }
    )
  }

  // Bloquear se houver lotes de estoque vinculados (sem CASCADE)
  const { count: lotsCount, error: lotsError } = await admin
    .from('stock_lots')
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', supplierId)

  if (lotsError) return NextResponse.json({ error: lotsError.message }, { status: 500 })

  if (lotsCount && lotsCount > 0) {
    return NextResponse.json(
      { error: 'Fornecedor possui entradas de estoque e não pode ser excluído.' },
      { status: 409 }
    )
  }

  const { error: deleteError } = await admin
    .from('suppliers')
    .delete()
    .eq('id', supplierId)

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
