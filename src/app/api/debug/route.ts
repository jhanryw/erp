import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const results: Record<string, any> = {}

  // 1. Env vars
  results.env = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'MISSING',
    anon_key_set: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service_role_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    next_public_service_role_set: !!process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY,
    anon_key_prefix: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').substring(0, 30) + '...',
    service_key_prefix: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').substring(0, 30) + '...',
  }

  // 2. Testa ping ao Supabase URL
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
      },
      signal: AbortSignal.timeout(5000),
    })
    results.ping = { status: res.status, ok: res.ok, statusText: res.statusText }
  } catch (e: any) {
    results.ping = { error: e.message }
  }

  // 3. Testa SELECT via SDK (server client)
  try {
    const supabase = createClient()
    const { data, error, count } = await supabase
      .from('suppliers')
      .select('id, name', { count: 'exact' })
      .limit(1)
    results.select_suppliers = { data, error, count }
  } catch (e: any) {
    results.select_suppliers = { exception: e.message }
  }

  // 4. Testa INSERT de teste via SDK
  try {
    const supabase = createClient()
    const { data, error } = await (supabase as any)
      .from('suppliers')
      .insert({ name: '__DEBUG_TEST__', active: false })
      .select('id')
      .single()
    results.insert_test = { data, error }

    // Se inseriu, apaga
    if (data?.id) {
      await supabase.from('suppliers').delete().eq('id', data.id)
      results.insert_test.cleaned_up = true
    }
  } catch (e: any) {
    results.insert_test = { exception: e.message }
  }

  // 5. Testa permissões de tabelas
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .rpc('version') as any
    results.db_version = { data, error }
  } catch (e: any) {
    results.db_version = { exception: e.message }
  }

  return NextResponse.json(results, { status: 200 })
}
