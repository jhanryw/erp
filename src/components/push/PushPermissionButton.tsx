'use client'

import { useState, useEffect } from 'react'
import { Bell, BellOff } from 'lucide-react'

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported')
      return
    }
    setState(Notification.permission as PermissionState)
  }, [])

  async function handleEnable() {
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return

    try {
      const permission = await Notification.requestPermission()
      setState(permission as PermissionState)
      if (permission !== 'granted') return

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
      })

      const key = sub.getKey('p256dh')
      const auth = sub.getKey('auth')

      await fetch('/api/push/subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint:   sub.endpoint,
          p256dh:     key  ? btoa(String.fromCharCode(...new Uint8Array(key)))  : '',
          auth:       auth ? btoa(String.fromCharCode(...new Uint8Array(auth))) : '',
          user_agent: navigator.userAgent,
        }),
      })

      setSubscribed(true)
    } catch (err) {
      console.error('[Push] Falha ao ativar notificações:', err)
    }
  }

  async function handleDisable() {
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
    }
  }

  if (state === 'loading' || state === 'unsupported') return null

  if (state === 'denied') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-muted">
        <BellOff className="h-4 w-4" />
        <span>Notificações bloqueadas no navegador</span>
      </div>
    )
  }

  if (state === 'granted' && subscribed) {
    return (
      <button
        onClick={handleDisable}
        className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover transition-colors"
      >
        <Bell className="h-4 w-4 text-brand" />
        <span>Notificações ativas — desativar</span>
      </button>
    )
  }

  return (
    <button
      onClick={handleEnable}
      className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover transition-colors"
    >
      <Bell className="h-4 w-4" />
      <span>Ativar notificações neste dispositivo</span>
    </button>
  )
}
