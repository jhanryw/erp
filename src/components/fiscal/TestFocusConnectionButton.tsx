'use client'

/**
 * Botão "Testar conexão" — único gatilho de chamada de rede real à Focus
 * NFe nesta fase (GET /v2/empresas via /api/fiscal/health POST). Nunca
 * automático — só dispara com clique explícito do usuário.
 */

import { useState } from 'react'
import { Loader2, PlugZap } from 'lucide-react'

interface ConnectionTestResult {
  connected: boolean
  environment?: string
  empresasCount?: number
  error?: string
}

export function TestFocusConnectionButton() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectionTestResult | null>(null)

  async function handleTest() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/fiscal/health', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setResult({ connected: false, error: data.error ?? 'Falha ao testar conexão.' })
        return
      }
      setResult(data.connectionTest)
    } catch (err) {
      setResult({ connected: false, error: err instanceof Error ? err.message : 'Erro desconhecido.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleTest}
        disabled={busy}
        className="inline-flex items-center gap-2 text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 hover:bg-brand-dark transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
        Testar conexão com a Focus NFe
      </button>

      {result && (
        <p className={`text-xs ${result.connected ? 'text-emerald-600' : 'text-red-500'}`}>
          {result.connected
            ? `Conectado (${result.environment}) — ${result.empresasCount} empresa(s) habilitada(s) neste token.`
            : result.error}
        </p>
      )}
    </div>
  )
}
