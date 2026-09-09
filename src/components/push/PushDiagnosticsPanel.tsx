'use client'

import { useState, useEffect, useCallback } from 'react'
import { Bell, Loader2, RefreshCw, Send } from 'lucide-react'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from(Array.from(raw), (c) => c.charCodeAt(0))
}

function truncateEndpoint(endpoint: string): string {
  if (endpoint.length <= 56) return endpoint
  return `${endpoint.slice(0, 36)}…${endpoint.slice(-12)}`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}

type PermissionState = NotificationPermission | 'unsupported'

interface ServerStatus {
  vapidBackendConfigured: boolean
  lastRegisteredAt:       string | null
  lastPushAt:             string | null
  lastStatus:             string | number | null
  lastError:              string | null
}

const TEST_FAILURE_MESSAGES: Record<string, string> = {
  VAPID_NOT_CONFIGURED:   'VAPID não configurada no servidor (faltam VAPID_SUBJECT/NEXT_PUBLIC_VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY em runtime).',
  NO_ACTIVE_SUBSCRIPTION: 'Nenhuma assinatura ativa encontrada para este usuário — clique em "Ativar notificações" primeiro.',
  WEB_PUSH_FAILED:        'O provedor de push recusou o envio',
}

interface Row {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'muted'
}

function StatusRow({ label, value, tone = 'muted' }: Row) {
  const toneClass =
    tone === 'ok' ? 'text-brand' : tone === 'warn' ? 'text-error' : 'text-text-primary'
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs font-medium ${toneClass}`}>{value}</span>
    </div>
  )
}

/** Diagnóstico completo da cadeia de Web Push deste dispositivo + ações reais (não simuladas). */
export function PushDiagnosticsPanel() {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'enable' | 'disable' | 'renew' | 'test' | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [standalone, setStandalone] = useState(false)
  const [permission, setPermission] = useState<PermissionState>('default')
  const [swActive, setSwActive] = useState(false)
  const [swScope, setSwScope] = useState<string | null>(null)
  const [pushManagerAvailable, setPushManagerAvailable] = useState(false)
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)

  const refreshClientState = useCallback(async () => {
    if (typeof window === 'undefined') return

    const nav = window.navigator as Navigator & { standalone?: boolean }
    setStandalone(window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true)
    setPermission('Notification' in window ? Notification.permission : 'unsupported')
    setPushManagerAvailable('PushManager' in window)

    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      setSwActive(!!reg?.active)
      setSwScope(reg?.scope ?? null)
      setSubscription(reg ? await reg.pushManager.getSubscription() : null)
    }
  }, [])

  const refreshServerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/push/status')
      if (res.ok) setServerStatus(await res.json())
    } catch {
      // silencioso — os campos dependentes do servidor mostram "—"
    }
  }, [])

  useEffect(() => {
    Promise.all([refreshClientState(), refreshServerStatus()]).finally(() => setLoading(false))
  }, [refreshClientState, refreshServerStatus])

  async function doDisable() {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      })
      await sub.unsubscribe()
    }
  }

  async function doEnable() {
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapidKey) throw new Error('VAPID pública não configurada no build do app.')

    const permissionResult = await Notification.requestPermission()
    setPermission(permissionResult)
    if (permissionResult !== 'granted') throw new Error('Permissão não concedida.')

    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
    })

    const key  = sub.getKey('p256dh')
    const auth = sub.getKey('auth')

    const res = await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint:   sub.endpoint,
        p256dh:     key  ? btoa(String.fromCharCode(...new Uint8Array(key)))  : '',
        auth:       auth ? btoa(String.fromCharCode(...new Uint8Array(auth))) : '',
        user_agent: navigator.userAgent,
      }),
    })
    if (!res.ok) throw new Error('Falha ao salvar a assinatura no servidor.')
  }

  async function handleEnable() {
    setBusy('enable')
    setMessage(null)
    try {
      await doEnable()
      setMessage({ type: 'ok', text: 'Notificações ativadas neste dispositivo.' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Não foi possível ativar as notificações.' })
    } finally {
      await Promise.all([refreshClientState(), refreshServerStatus()])
      setBusy(null)
    }
  }

  async function handleDisable() {
    setBusy('disable')
    setMessage(null)
    try {
      await doDisable()
      setMessage({ type: 'ok', text: 'Notificações desativadas neste dispositivo.' })
    } catch {
      setMessage({ type: 'error', text: 'Não foi possível desativar as notificações.' })
    } finally {
      await refreshClientState()
      setBusy(null)
    }
  }

  async function handleRenew() {
    setBusy('renew')
    setMessage(null)
    try {
      await doDisable()
      await doEnable()
      setMessage({ type: 'ok', text: 'Assinatura renovada.' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Falha ao renovar assinatura.' })
    } finally {
      await Promise.all([refreshClientState(), refreshServerStatus()])
      setBusy(null)
    }
  }

  async function handleTest() {
    setBusy('test')
    setMessage(null)
    try {
      const res = await fetch('/api/push/test', { method: 'POST' })
      const data = await res.json()

      if (!data.ok) {
        const base = TEST_FAILURE_MESSAGES[data.reason] ?? 'Falha ao enviar notificação de teste.'
        const text = data.reason === 'WEB_PUSH_FAILED' && data.statusCode ? `${base} (status ${data.statusCode}).` : base
        throw new Error(text)
      }

      setMessage({ type: 'ok', text: `Notificação de teste enviada (${data.sent}/${data.subscriptionsFound} dispositivo(s)).` })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Falha ao enviar notificação de teste.' })
    } finally {
      await refreshServerStatus()
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-xs text-text-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Verificando estado das notificações…
      </div>
    )
  }

  const isSubscribed = permission === 'granted' && !!subscription
  const unsupported = permission === 'unsupported' || !pushManagerAvailable
  // Lido diretamente aqui (não via API): reflete literalmente o que foi
  // inlinado no bundle do cliente no momento do `next build` — é isso que
  // decide se PushManager.subscribe() consegue montar a applicationServerKey,
  // não o que o servidor tem em runtime (isso é vapidBackendConfigured).
  const vapidFrontendConfigured = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start gap-4">
        <div className={`p-2 rounded-lg shrink-0 ${isSubscribed ? 'bg-brand/10' : 'bg-bg-overlay'}`}>
          <Bell className={`w-4 h-4 ${isSubscribed ? 'text-brand' : 'text-text-secondary'}`} />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary mb-1">Notificações deste dispositivo</p>
          <p className="text-xs text-text-muted">
            Diagnóstico da cadeia completa de Web Push — permissão, Service Worker e assinatura.
          </p>
        </div>
      </div>

      {unsupported ? (
        <p className="text-xs text-text-muted">Este navegador não suporta notificações push.</p>
      ) : (
        <>
          <div className="rounded-lg border border-border px-3">
            <StatusRow label="Modo" value={standalone ? 'PWA' : 'Browser'} />
            <StatusRow label="Standalone" value={standalone ? 'Sim' : 'Não'} />
            <StatusRow
              label="Notification.permission"
              value={permission}
              tone={permission === 'granted' ? 'ok' : permission === 'denied' ? 'warn' : 'muted'}
            />
            <StatusRow label="Service Worker" value={swActive ? 'Ativo' : 'Inativo'} tone={swActive ? 'ok' : 'warn'} />
            <StatusRow label="Service Worker scope" value={swScope ?? '—'} />
            <StatusRow label="PushManager" value={pushManagerAvailable ? 'Disponível' : 'Indisponível'} />
            <StatusRow label="Subscription" value={subscription ? 'Ativa' : 'Inativa'} tone={subscription ? 'ok' : 'muted'} />
            <StatusRow label="Endpoint" value={subscription ? truncateEndpoint(subscription.endpoint) : '—'} />
            <StatusRow
              label="VAPID frontend"
              value={vapidFrontendConfigured ? 'Configurada' : 'Não configurada'}
              tone={vapidFrontendConfigured ? 'ok' : 'warn'}
            />
            <StatusRow
              label="VAPID backend"
              value={serverStatus?.vapidBackendConfigured ? 'Configurada' : 'Não configurada'}
              tone={serverStatus?.vapidBackendConfigured ? 'ok' : 'warn'}
            />
            <StatusRow label="Último registro" value={formatDateTime(serverStatus?.lastRegisteredAt ?? null)} />
            <StatusRow label="Último push enviado" value={formatDateTime(serverStatus?.lastPushAt ?? null)} />
            <StatusRow
              label="Último status"
              value={serverStatus?.lastStatus != null ? String(serverStatus.lastStatus) : '—'}
              tone={serverStatus?.lastStatus === 201 ? 'ok' : serverStatus?.lastStatus ? 'warn' : 'muted'}
            />
            {serverStatus?.lastError && (
              <StatusRow label="Último erro" value={serverStatus.lastError} tone="warn" />
            )}
          </div>

          {message && (
            <p className={`text-xs ${message.type === 'ok' ? 'text-brand' : 'text-error'}`}>{message.text}</p>
          )}

          {permission === 'denied' && (
            <p className="text-xs text-text-muted">
              Notificações bloqueadas no navegador. Libere manualmente nas configurações do site para reativar.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {isSubscribed ? (
              <button
                onClick={handleDisable}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                {busy === 'disable' && <Loader2 className="w-3 h-3 animate-spin" />}
                Desativar notificações
              </button>
            ) : (
              <button
                onClick={handleEnable}
                disabled={busy !== null || permission === 'denied'}
                className="inline-flex items-center gap-2 text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 hover:bg-brand-dark transition-colors disabled:opacity-50"
              >
                {busy === 'enable' && <Loader2 className="w-3 h-3 animate-spin" />}
                Ativar notificações
              </button>
            )}

            <button
              onClick={handleTest}
              disabled={busy !== null || !isSubscribed}
              className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy === 'test' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Enviar notificação de teste
            </button>

            <button
              onClick={handleRenew}
              disabled={busy !== null || !isSubscribed}
              className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy === 'renew' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Renovar assinatura
            </button>
          </div>
        </>
      )}
    </div>
  )
}
