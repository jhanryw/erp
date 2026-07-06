'use client'

import { useState, useEffect } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from(Array.from(raw), (c) => c.charCodeAt(0))
}

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported' | 'loading'

export function PushPermissionButton() {
  const [state, setState] = useState<PermissionState>('loading')
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported')
      return
    }

    const perm = Notification.permission as PermissionState
    setState(perm)

    // Verifica se já tem assinatura ativa neste dispositivo
    if (perm === 'granted') {
      navigator.serviceWorker.ready.then((reg) =>
        reg.pushManager.getSubscription().then((sub) => setSubscribed(!!sub))
      )
    }
  }, [])

  async function handleEnable() {
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapidKey) {
      console.error('[Push] NEXT_PUBLIC_VAPID_PUBLIC_KEY não configurada.')
      return
    }

    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      setState(permission as PermissionState)
      if (permission !== 'granted') return

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

      if (res.ok) setSubscribed(true)
    } catch (err) {
      console.error('[Push] Falha ao ativar notificações:', err)
    } finally {
      setBusy(false)
    }
  }

  async function handleDisable() {
    setBusy(true)
    try {
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
      setSubscribed(false)
    } catch (err) {
      console.error('[Push] Falha ao desativar notificações:', err)
    } finally {
      setBusy(false)
    }
  }

  // Não renderiza nada até saber o estado real
  if (state === 'loading') return null
  // Navegador não suporta push — silencioso
  if (state === 'unsupported') return null

  if (state === 'denied') {
    return (
      <div className="card p-5 flex items-start gap-4">
        <div className="p-2 rounded-lg bg-bg-overlay shrink-0">
          <BellOff className="w-4 h-4 text-text-muted" />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary mb-1">Notificações bloqueadas</p>
          <p className="text-xs text-text-muted">
            Você bloqueou as notificações no navegador. Para ativar, vá em Configurações do navegador
            e permita notificações para este site.
          </p>
        </div>
      </div>
    )
  }

  const isActive = state === 'granted' && subscribed

  return (
    <div className="card p-5 flex items-start gap-4">
      <div className={`p-2 rounded-lg shrink-0 ${isActive ? 'bg-brand/10' : 'bg-bg-overlay'}`}>
        <Bell className={`w-4 h-4 ${isActive ? 'text-brand' : 'text-text-secondary'}`} />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary mb-1">
          {isActive ? 'Notificações ativas neste dispositivo' : 'Ativar notificações neste dispositivo'}
        </p>
        <p className="text-xs text-text-muted mb-3">
          Receba alertas de novas vendas no celular ou computador.
        </p>

        {isActive ? (
          <button
            onClick={handleDisable}
            disabled={busy}
            className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Desativar neste dispositivo
          </button>
        ) : (
          <button
            onClick={handleEnable}
            disabled={busy}
            className="inline-flex items-center gap-2 text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 hover:bg-brand-dark transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Ativar notificações
          </button>
        )}
      </div>
    </div>
  )
}
