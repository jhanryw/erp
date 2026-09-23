'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, CheckCircle2, AlertTriangle, PlugZap, RefreshCw, Unplug, KeyRound, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { MercadoLivreConnectionView } from '@/services/integrations/mercadolivre.service'

const REASON_MESSAGES: Record<string, string> = {
  oauth_denied: 'A autorização foi recusada no Mercado Livre.',
  invalid_state: 'O pedido de conexão expirou ou não pertence a esta sessão. Tente conectar de novo.',
  account_conflict: 'Esta conta do Mercado Livre já está conectada a outra empresa.',
  reauth_required: 'O Mercado Livre recusou a autorização. Conecte novamente.',
  config: 'A integração ainda não foi configurada no servidor (credenciais do app Qarvon).',
  session: 'Sua sessão expirou durante a conexão. Entre de novo e reconecte.',
  forbidden: 'Somente administradores da empresa podem conectar o Mercado Livre.',
  rate_limited: 'O Mercado Livre limitou as requisições. Aguarde alguns segundos e tente de novo.',
  server: 'O Mercado Livre está instável no momento. Tente novamente em instantes.',
  timeout: 'O Mercado Livre demorou a responder. Tente novamente.',
  network: 'Falha de comunicação com o Mercado Livre. Tente novamente.',
}

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

interface Props {
  initial: MercadoLivreConnectionView | null
  loadError: boolean
  flash: string | null
  reason: string | null
}

export function MercadoLivreIntegration({ initial, loadError, flash, reason }: Props) {
  const router = useRouter()
  const [connection, setConnection] = useState(initial)
  const [busy, setBusy] = useState<null | 'revalidate' | 'refresh' | 'disconnect'>(null)

  // Mensagem do retorno do OAuth — mostrada uma vez, e a URL é limpa.
  useEffect(() => {
    if (!flash) return
    if (flash === 'connected') toast.success('Conta do Mercado Livre conectada.')
    else if (flash === 'reconnected') toast.success('Conta do Mercado Livre reconectada.')
    else if (flash === 'error') toast.error('Não foi possível conectar', { description: REASON_MESSAGES[reason ?? ''] ?? 'Tente novamente.' })
    router.replace('/configuracoes/mercadolivre')
  }, [flash, reason, router])

  async function action(kind: 'revalidate' | 'refresh' | 'disconnect') {
    if (kind === 'disconnect' && !window.confirm('Desconectar a conta do Mercado Livre? Os tokens serão apagados; o histórico é preservado.')) return
    setBusy(kind)
    try {
      const res = await fetch(`/api/integrations/mercadolivre/${kind}`, { method: 'POST' })
      const json = await res.json()
      if (json.connection) setConnection(json.connection)
      if (!res.ok) {
        toast.error('Operação não concluída', { description: REASON_MESSAGES[json.kind] ?? json.error })
        if (json.kind === 'reauth_required') router.refresh()
        return
      }
      toast.success(kind === 'revalidate' ? 'Conexão validada.' : kind === 'refresh' ? 'Token renovado.' : 'Conta desconectada.')
    } catch {
      toast.error('Erro inesperado.')
    } finally {
      setBusy(null)
    }
  }

  const state = connection?.state ?? 'disconnected'

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes">
          <Button variant="ghost" size="icon" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Mercado Livre</h2>
          <p className="text-sm text-text-muted">Venda e sincronize seu catálogo com o Mercado Livre.</p>
        </div>
      </div>

      {loadError && (
        <div className="card flex items-start gap-3 p-5 text-sm text-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Não foi possível carregar o estado da integração.
        </div>
      )}

      {!loadError && state === 'not_configured' && (
        <div className="card space-y-2 p-6">
          <Badge variant="warning">Não configurada</Badge>
          <p className="text-sm text-text-secondary">
            As credenciais do aplicativo Qarvon no Mercado Livre (CLIENT_ID, CLIENT_SECRET e redirect URI) ainda não
            foram configuradas no servidor. Peça ao responsável técnico para concluir a configuração.
          </p>
        </div>
      )}

      {!loadError && state === 'disconnected' && (
        <div className="card space-y-4 p-6">
          <div className="flex items-center gap-2">
            <Badge variant="default">Desconectado</Badge>
            {connection?.disconnected_at && <span className="text-xs text-text-muted">desde {fmtDate(connection.disconnected_at)}</span>}
          </div>
          <p className="text-sm text-text-secondary">
            Conecte a conta de vendedor do Mercado Livre desta empresa. Você será levado ao Mercado Livre para autorizar o
            acesso — use a conta principal (administrador), não um usuário colaborador.
          </p>
          <a href="/api/integrations/mercadolivre/connect">
            <Button><PlugZap className="h-4 w-4" /> Conectar Mercado Livre</Button>
          </a>
        </div>
      )}

      {!loadError && (state === 'connected' || state === 'needs_reauth' || state === 'error') && connection && (
        <div className="card space-y-5 p-6">
          <div className="flex flex-wrap items-center gap-2">
            {state === 'connected' && <Badge variant="success"><CheckCircle2 className="mr-1 inline h-3 w-3" />Conectado</Badge>}
            {state === 'needs_reauth' && <Badge variant="warning"><KeyRound className="mr-1 inline h-3 w-3" />Reautorização necessária</Badge>}
            {state === 'error' && <Badge variant="error">Erro</Badge>}
            {connection.is_test_user && <Badge variant="info"><FlaskConical className="mr-1 inline h-3 w-3" />Usuário TEST</Badge>}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-text-muted">Conta</dt><dd className="font-medium">{connection.nickname ?? '—'}</dd></div>
            <div><dt className="text-xs text-text-muted">Seller ID</dt><dd className="font-mono">{connection.seller_id ?? '—'}</dd></div>
            <div><dt className="text-xs text-text-muted">Site</dt><dd>{connection.site_id ?? '—'}{connection.country_id ? ` · ${connection.country_id}` : ''}</dd></div>
            <div><dt className="text-xs text-text-muted">Última validação</dt><dd>{fmtDate(connection.last_validated_at)}</dd></div>
            <div><dt className="text-xs text-text-muted">Conectado em</dt><dd>{fmtDate(connection.connected_at)}</dd></div>
            <div><dt className="text-xs text-text-muted">Token renovado em</dt><dd>{fmtDate(connection.credential_refreshed_at)} <span className="text-xs text-text-muted">(expira {fmtDate(connection.credential_expires_at)})</span></dd></div>
            {connection.permalink && (
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Perfil</dt>
                <dd><a href={connection.permalink} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{connection.permalink}</a></dd></div>
            )}
          </dl>

          {state === 'needs_reauth' && (
            <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-text-secondary">
              O Mercado Livre não aceita mais a autorização atual (senha alterada, acesso revogado ou expirado). Conecte novamente para continuar.
            </p>
          )}
          {state === 'error' && connection.last_error && (
            <p className="text-sm text-error">Último erro: {connection.last_error}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {state === 'needs_reauth' ? (
              <a href="/api/integrations/mercadolivre/connect"><Button><PlugZap className="h-4 w-4" /> Reautorizar</Button></a>
            ) : (
              <>
                <Button variant="secondary" onClick={() => action('revalidate')} loading={busy === 'revalidate'} disabled={busy !== null}>
                  <RefreshCw className="h-4 w-4" /> Revalidar conexão
                </Button>
                <Button variant="secondary" onClick={() => action('refresh')} loading={busy === 'refresh'} disabled={busy !== null}>
                  <KeyRound className="h-4 w-4" /> Renovar token
                </Button>
              </>
            )}
            <Button variant="danger" onClick={() => action('disconnect')} loading={busy === 'disconnect'} disabled={busy !== null}>
              <Unplug className="h-4 w-4" /> Desconectar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
