import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  name: z.string().min(2),
  sku: z.string().min(2).max(50),
  category_id: z.coerce.number().int().positive(),
  supplier_id: z.coerce.number().int().positive().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0),
  base_price: z.coerce.number().positive(),
  active: z.boolean().default(true),
})

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { data: product, error } = (await admin
    .from('products')
    .insert({ ...parsed.data, supplier_id: parsed.data.supplier_id ?? null, subcategory_id: null, collection_id: null } as any)
    .select('id')
    .single()) as unknown as { data: { id: number } | null; error: any }

  if (error) {
    const msg = error.code === '23505' ? 'SKU já cadastrado.' : error.code === '23503' ? 'Categoria ou fornecedor inválido.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ product }, { status: 201 })
}
