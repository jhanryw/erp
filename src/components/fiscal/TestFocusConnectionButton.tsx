'use client'

/**
 * Botão "Testar conexão" — dispara DOIS testes de rede reais e
 * INDEPENDENTES à Focus NFe via POST /api/fiscal/health (nunca automático
 * — só com clique explícito):
 *   - emissão: token de emissão do ambiente atual, operação read-only.
 *   - gerenciamento: master_token, sempre contra produção.
 * Um nunca prova o outro — por isso sempre aparecem como duas linhas
 * separadas, nunca um resultado único "tudo ok"/"tudo falhou".
 */

import { useState } from 'react'
import { Loader2, PlugZap } from 'lucide-react'

interface EmissionTestResult {
  connected: boolean
  environment?: string
  error?: string
}

interface ManagementTestResult {
  connected: boolean
  empresasCount?: number
  error?: string
}

export function TestFocusConnectionButton() {
  const [busy, setBusy] = useState(false)
  const [emissionResult, setEmissionResult] = useState<EmissionTestResult | null>(null)
  const [managementResult, setManagementResult] = useState<ManagementTestResult | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)

  async function handleTest() {
    setBusy(true)
    setEmissionResult(null)
    setManagementResult(null)
    setGeneralError(null)
    try {
      const res = await fetch('/api/fiscal/health', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setGeneralError(typeof data.error === 'string' ? data.error : 'Falha ao testar conexão.')
        return
      }
      setEmissionResult(data.emissionTest)
      setManagementResult(data.managementTest)
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : 'Erro desconhecido.')
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

      {generalError && <p className="text-xs text-red-500">{generalError}</p>}

      {emissionResult && (
        <p className={`text-xs ${emissionResult.connected ? 'text-emerald-600' : 'text-red-500'}`}>
          Emissão: {emissionResult.connected ? `conectado (${emissionResult.environment})` : emissionResult.error}
        </p>
      )}

      {managementResult && (
        <p className={`text-xs ${managementResult.connected ? 'text-emerald-600' : 'text-red-500'}`}>
          Gerenciamento: {managementResult.connected
            ? `conectado — ${managementResult.empresasCount} empresa(s) na conta.`
            : managementResult.error}
        </p>
      )}
    </div>
  )
}
