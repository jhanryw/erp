'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, CheckCircle2, AlertTriangle, PlugZap, Unplug, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ShopeeConnectionView, ShopeeShopView } from '@/services/integrations/shopee.service'

const REASON_MESSAGES: Record<string, string> = {
  oauth_denied: 'A autorização foi recusada na Shopee.',
  invalid_state: 'O pedido de conexão expirou ou não pertence a esta sessão. Tente conectar de novo.',
  invalid_callback: 'A Shopee não devolveu os dados da loja. Tente conectar de novo.',
  account_conflict: 'Esta loja Shopee já está conectada a outra empresa.',
  reauth_required: 'A Shopee recusou a autorização. Conecte a loja novamente.',
  config: 'A integração ainda não foi configurada no servidor (credenciais do app Qarvon na Shopee).',
  session: 'Sua sessão expirou durante a conexão. Entre de novo e reconecte.',
  forbidden: 'Somente administradores da empresa podem conectar a Shopee.',
  rate_limited: 'A Shopee limitou as requisições. Aguarde alguns segundos e tente de novo.',
  server: 'A Shopee está instável no momento. Tente novamente em instantes.',
  timeout: 'A Shopee demorou a responder. Tente novamente.',
  network: 'Falha de comunicação com a Shopee. Tente novamente.',
  integration_not_found: 'Loja não encontrada nesta empresa.',
}

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

interface Props {
  initial: ShopeeConnectionView | null
  loadError: boolean
  flash: string | null
  reason: string | null
}

export function ShopeeIntegration({ initial, loadError, flash, reason }: Props) {
  const router = useRouter()
  const [shops, setShops] = useState<ShopeeShopView[]>(initial?.shops ?? [])
  const [busy, setBusy] = useState<null | { id: number; kind: 'refresh' | 'disconnect' }>(null)
  const configured = initial?.configured ?? false

  useEffect(() => {
    if (!flash) return
    if (flash === 'connected') toast.success('Loja Shopee conectada.')
    else if (flash === 'reconnected') toast.success('Loja Shopee reconectada.')
    else if (flash === 'error') toast.error('Não foi possível conectar', { description: REASON_MESSAGES[reason ?? ''] ?? 'Tente novamente.' })
    router.replace('/configuracoes/shopee')
  }, [flash, reason, router])

  async function action(shop: ShopeeShopView, kind: 'refresh' | 'disconnect') {
    if (kind === 'disconnect' && !window.confirm(`Desconectar a loja ${shop.shop_id ?? ''}? Os tokens serão apagados; o histórico é preservado.`)) return
    setBusy({ id: shop.integration_id, kind })
    try {
      const res = await fetch(`/api/integrations/shopee/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ integration_id: shop.integration_id }),
      })
      const json = await res.json()
      if (json.shop) setShops((prev) => prev.map((s) => (s.integration_id === json.shop.integration_id ? json.shop : s)))
      if (!res.ok) {
        toast.error('Operação não concluída', { description: REASON_MESSAGES[json.kind] ?? json.error })
        if (json.kind === 'reauth_required') router.refresh()
        return
      }
      toast.success(kind === 'refresh' ? 'Token renovado.' : 'Loja desconectada.')
    } catch {
      toast.error('Erro inesperado.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes">
          <Button variant="ghost" size="icon" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Shopee</h2>
          <p className="text-sm text-text-muted">Conecte as lojas Shopee da empresa.</p>
        </div>
      </div>

      {loadError && (
        <div className="card flex items-start gap-3 p-5 text-sm text-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Não foi possível carregar o estado da integração.
        </div>
      )}

      {!loadError && !configured && (
        <div className="card space-y-2 p-6">
          <Badge variant="warning">Não configurada</Badge>
          <p className="text-sm text-text-secondary">
            As credenciais do aplicativo Qarvon na Shopee (partner_id, partner_key e redirect URI) ainda não foram
            configuradas no servidor. Peça ao responsável técnico para concluir a configuração.
          </p>
        </div>
      )}

      {!loadError && configured && (
        <div className="card space-y-3 p-6">
          <p className="text-sm text-text-secondary">
            {shops.some((s) => s.state !== 'disconnected')
              ? 'Você pode conectar outras lojas Shopee desta empresa.'
              : 'Nenhuma loja conectada. Você será levado à Shopee para autorizar o acesso à loja.'}
          </p>
          <a href="/api/integrations/shopee/connect">
            <Button><PlugZap className="h-4 w-4" /> Conectar loja Shopee</Button>
          </a>
        </div>
      )}

      {!loadError && shops.map((shop) => (
        <div key={shop.integration_id} className="card space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-2">
            {shop.state === 'connected' && <Badge variant="success"><CheckCircle2 className="mr-1 inline h-3 w-3" />Conectada</Badge>}
            {shop.state === 'needs_reauth' && <Badge variant="warning"><KeyRound className="mr-1 inline h-3 w-3" />Reautorização necessária</Badge>}
            {shop.state === 'error' && <Badge variant="error">Erro</Badge>}
            {shop.state === 'disconnected' && <Badge variant="default">Desconectada</Badge>}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-text-muted">Shop ID</dt><dd className="font-mono">{shop.shop_id ?? '—'}</dd></div>
            <div><dt className="text-xs text-text-muted">Conectada em</dt><dd>{fmtDate(shop.connected_at)}</dd></div>
            {shop.state !== 'disconnected' ? (
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Token renovado em</dt>
                <dd>{fmtDate(shop.credential_refreshed_at)} <span className="text-xs text-text-muted">(expira {fmtDate(shop.credential_expires_at)})</span></dd></div>
            ) : (
              <div><dt className="text-xs text-text-muted">Desconectada em</dt><dd>{fmtDate(shop.disconnected_at)}</dd></div>
            )}
          </dl>

          {shop.state === 'needs_reauth' && (
            <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-text-secondary">
              A Shopee não aceita mais a autorização atual desta loja (expirada ou revogada). Conecte novamente para continuar.
            </p>
          )}
          {shop.state === 'error' && shop.last_error && <p className="text-sm text-error">Último erro: {shop.last_error}</p>}

          {shop.state !== 'disconnected' && (
            <div className="flex flex-wrap gap-2">
              {shop.state === 'needs_reauth' ? (
                configured && <a href="/api/integrations/shopee/connect"><Button><PlugZap className="h-4 w-4" /> Reautorizar</Button></a>
              ) : (
                <Button variant="secondary" onClick={() => action(shop, 'refresh')} loading={busy?.id === shop.integration_id && busy.kind === 'refresh'} disabled={busy !== null}>
                  <KeyRound className="h-4 w-4" /> Renovar token
                </Button>
              )}
              <Button variant="danger" onClick={() => action(shop, 'disconnect')} loading={busy?.id === shop.integration_id && busy.kind === 'disconnect'} disabled={busy !== null}>
                <Unplug className="h-4 w-4" /> Desconectar
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
