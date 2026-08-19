import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft, Receipt, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { TestFocusConnectionButton } from '@/components/fiscal/TestFocusConnectionButton'
import { getFiscalHealth } from '@/services/fiscal/health.service'

export const dynamic = 'force-dynamic'

const FOCUS_REASON_LABELS: Record<string, string> = {
  integration_not_found: 'Integração Focus NFe não cadastrada.',
  integration_disabled: 'Integração Focus NFe cadastrada, mas não está ativa.',
  token_missing: 'Integração ativa, mas sem token configurado.',
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
      <div>
        <p className="text-sm text-text-primary">{label}</p>
        {detail && <p className="text-xs text-text-muted mt-0.5">{detail}</p>}
      </div>
    </div>
  )
}

export default async function ConfigFiscalPage() {
  const profile = await requirePageRole('admin')

  if (!profile.company_id) {
    return <p className="text-sm text-text-muted">Usuário sem empresa associada.</p>
  }

  const result = await getFiscalHealth(profile.company_id)

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Receipt className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Fiscal</h2>
            <p className="text-sm text-text-muted">Fundação da emissão de NF-e via Focus NFe (homologação)</p>
          </div>
        </div>
      </div>

      {!result.ok ? (
        <Card className="p-5">
          <p className="text-sm text-red-500">Falha ao carregar status fiscal: {result.error}</p>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <p className="text-sm font-semibold text-text-primary">Ambiente: {result.data.environment}</p>
            </div>
            <p className="text-xs text-text-muted">
              Nesta fase, apenas homologação é suportada — nenhuma nota é emitida em produção por esta fundação.
            </p>
          </Card>

          <Card className="p-5 divide-y divide-border">
            <StatusRow
              ok={result.data.fiscalSettingsConfigured}
              label="Configuração fiscal da empresa"
              detail={result.data.fiscalSettingsConfigured ? undefined : 'Nenhum registro em company_fiscal_settings ainda — cadastro pendente.'}
            />
            <StatusRow
              ok={result.data.emitente.complete}
              label="Dados do emitente completos"
              detail={result.data.emitente.complete ? undefined : `Pendente: ${result.data.emitente.missingFields.join(', ')}`}
            />
            <StatusRow
              ok={result.data.focusIntegration.connected}
              label="Integração Focus NFe configurada"
              detail={result.data.focusIntegration.reason ? FOCUS_REASON_LABELS[result.data.focusIntegration.reason] : undefined}
            />
            <StatusRow
              ok={result.data.nfeEnabled}
              label="Emissão de NF-e habilitada"
            />
          </Card>

          <Card className="p-5">
            <p className="text-sm font-semibold text-text-primary mb-2">Testar conexão</p>
            <p className="text-xs text-text-muted mb-3">
              Faz uma chamada real e segura à Focus NFe (consulta de empresas habilitadas) para confirmar que o token está válido. Não emite nenhum documento.
            </p>
            <TestFocusConnectionButton />
          </Card>

          <p className="text-xs text-text-muted">
            Cadastro de CNPJ, razão social, endereço e token da Focus NFe ainda não tem tela própria nesta fase —
            é uma etapa pendente da próxima fase fiscal.
          </p>
        </>
      )}
    </div>
  )
}
