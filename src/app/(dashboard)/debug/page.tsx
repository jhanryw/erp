'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function DebugPage() {
  const [serverResult, setServerResult] = useState<any>(null)
  const [clientResult, setClientResult] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Teste server-side
    fetch('/api/debug')
      .then(r => r.json())
      .then(d => setServerResult(d))
      .catch(e => setServerResult({ error: e.message }))

    // Teste client-side (browser → Supabase direto)
    async function testClient() {
      const supabase = createClient()
      const results: Record<string, any> = {}

      // Qual key está sendo usada?
      results.key_used = {
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
          ? process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY.substring(0, 40) + '...'
          : 'NÃO DEFINIDA',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
          ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.substring(0, 40) + '...'
          : 'NÃO DEFINIDA',
        url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      }

      // SELECT
      try {
        const { data, error } = await supabase.from('suppliers').select('id, name').limit(1) as any
        results.client_select = { data, error }
      } catch (e: any) {
        results.client_select = { exception: e.message }
      }

      // INSERT teste
      try {
        const { data, error } = await (supabase as any)
          .from('suppliers')
          .insert({ name: '__CLIENT_DEBUG__', active: false })
          .select('id')
          .single()
        results.client_insert = { data, error }
        if (data?.id) {
          await (supabase as any).from('suppliers').delete().eq('id', data.id)
          results.client_insert.cleaned_up = true
        }
      } catch (e: any) {
        results.client_insert = { exception: e.message }
      }

      setClientResult(results)
      setLoading(false)
    }
    testClient()
  }, [])

  const block = (title: string, data: any) => (
    <div className="mb-6">
      <h3 className="text-sm font-bold text-text-primary mb-2">{title}</h3>
      <pre className="bg-bg-overlay border border-border rounded-xl p-4 text-xs text-text-secondary overflow-auto whitespace-pre-wrap break-all">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">🔍 Diagnóstico de Conexão Supabase</h2>
        <p className="text-sm text-text-muted">Testa server-side e client-side em tempo real</p>
      </div>

      {loading && <p className="text-sm text-text-muted animate-pulse">Testando conexões...</p>}

      <div className="card p-5">
        <h3 className="text-sm font-bold text-text-primary mb-4">🖥️ Server-Side (service_role)</h3>
        {serverResult ? (
          <>
            {block('Variáveis de Ambiente', serverResult.env)}
            {block('Ping ao Supabase URL', serverResult.ping)}
            {block('SELECT suppliers', serverResult.select_suppliers)}
            {block('INSERT teste', serverResult.insert_test)}
            {block('DB Version', serverResult.db_version)}
          </>
        ) : <p className="text-xs text-text-muted">Carregando...</p>}
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-bold text-text-primary mb-4">🌐 Client-Side (browser → Supabase direto)</h3>
        {clientResult ? (
          <>
            {block('Keys no Browser', clientResult.key_used)}
            {block('SELECT suppliers', clientResult.client_select)}
            {block('INSERT teste', clientResult.client_insert)}
          </>
        ) : <p className="text-xs text-text-muted">Carregando...</p>}
      </div>
    </div>
  )
}
