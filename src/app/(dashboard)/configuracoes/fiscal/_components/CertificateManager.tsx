'use client'

/**
 * Motor Fiscal Configurável — Fase 2: certificado digital (A1).
 *
 * Depois do upload, mostra APENAS metadata segura (seção 21 do pedido) —
 * nunca o PFX, nunca a senha. "Substituir" é a única ação pra trocar
 * (mesmo formulário de upload) — nunca um "baixar certificado".
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface CertificateMetadata {
  certificate_status: string
  certificate_subject: string | null
  certificate_cnpj: string | null
  certificate_issuer: string | null
  certificate_serial: string | null
  certificate_fingerprint: string | null
  certificate_valid_from: string | null
  certificate_valid_until: string | null
  certificate_uploaded_at: string | null
}

const STATUS_LABEL: Record<string, string> = {
  not_configured: 'Não configurado',
  valid: 'Válido',
  expired: 'Expirado',
  invalid: 'Inválido',
  replaced: 'Substituído',
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'valid') return <ShieldCheck className="w-4 h-4 text-emerald-600" />
  if (status === 'expired' || status === 'invalid') return <ShieldX className="w-4 h-4 text-red-500" />
  return <ShieldAlert className="w-4 h-4 text-amber-500" />
}

export function CertificateManager() {
  const [cert, setCert] = useState<CertificateMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [validating, setValidating] = useState(false)

  function load() {
    setLoading(true)
    fetch('/api/configuracoes/fiscal/certificado')
      .then((r) => r.json())
      .then((json) => setCert(json.certificate ?? null))
      .catch(() => toast.error('Erro ao carregar status do certificado.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { toast.error('Selecione um arquivo .pfx ou .p12.'); return }
    if (!password) { toast.error('Informe a senha do certificado.'); return }

    setUploading(true)
    try {
      const form = new FormData()
      form.append('certificado', file)
      form.append('senha', password)
      const res = await fetch('/api/configuracoes/fiscal/certificado', { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao enviar certificado', { description: typeof json.error === 'string' ? json.error : 'Verifique o arquivo e a senha.' })
        return
      }
      // Local e Focus são reportados SEPARADAMENTE — salvar localmente
      // nunca implica "sincronizado e pronto para emitir".
      if (json.certificate?.cnpjMismatch) {
        toast.warning('Certificado salvo localmente, mas o CNPJ diverge do CNPJ cadastrado da empresa — confira.')
      } else {
        toast.success('Certificado salvo localmente.')
      }
      if (json.focus?.status === 'success') {
        toast.success('Certificado sincronizado com a Focus.')
      } else {
        toast.error('Falha ao sincronizar certificado com a Focus', { description: json.focus?.lastError ?? undefined })
      }
      setFile(null)
      setPassword('')
      setShowForm(false)
      load()
    } catch {
      toast.error('Erro inesperado ao enviar certificado.')
    } finally {
      setUploading(false)
    }
  }

  async function validate() {
    setValidating(true)
    try {
      const res = await fetch('/api/configuracoes/fiscal/certificado/validar', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Certificado inválido', { description: typeof json.error === 'string' ? json.error : undefined })
        load()
        return
      }
      toast.success('Certificado válido e íntegro.')
      load()
    } catch {
      toast.error('Erro inesperado ao validar certificado.')
    } finally {
      setValidating(false)
    }
  }

  if (loading) return <p className="text-sm text-text-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</p>

  const status = cert?.certificate_status ?? 'not_configured'

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <p className="text-sm font-semibold text-text-primary">Certificado digital: {STATUS_LABEL[status] ?? status}</p>
      </div>

      {status !== 'not_configured' && cert && (
        <div className="text-xs text-text-muted space-y-1 pl-6">
          {cert.certificate_subject && <p>Titular: {cert.certificate_subject}</p>}
          {cert.certificate_cnpj && <p>CNPJ do certificado: {cert.certificate_cnpj}</p>}
          {cert.certificate_issuer && <p>Emissor: {cert.certificate_issuer}</p>}
          {cert.certificate_serial && <p>Número de série: {cert.certificate_serial}</p>}
          {cert.certificate_valid_until && <p>Válido até: {new Date(cert.certificate_valid_until).toLocaleDateString('pt-BR')}</p>}
          {cert.certificate_fingerprint && <p className="break-all">Fingerprint: {cert.certificate_fingerprint}</p>}
          {cert.certificate_uploaded_at && <p>Enviado em: {new Date(cert.certificate_uploaded_at).toLocaleString('pt-BR')}</p>}
        </div>
      )}

      <div className="flex gap-2">
        {status !== 'not_configured' && (
          <Button size="sm" variant="secondary" onClick={validate} loading={validating}>Validar certificado</Button>
        )}
        <Button size="sm" variant={status === 'not_configured' ? 'primary' : 'secondary'} onClick={() => setShowForm((v) => !v)}>
          {status === 'not_configured' ? 'Enviar certificado' : 'Substituir'}
        </Button>
      </div>

      {showForm && (
        <form onSubmit={upload} className="space-y-2 pt-2 border-t border-border">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Arquivo (.pfx ou .p12)</label>
            <input
              type="file" accept=".pfx,.p12"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-xs w-full"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Senha do certificado</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="text-xs w-full px-2 py-1.5 rounded-md border border-border bg-bg-card"
              placeholder="••••••••"
            />
          </div>
          <Button type="submit" size="sm" loading={uploading}>Salvar certificado</Button>
        </form>
      )}
    </Card>
  )
}
