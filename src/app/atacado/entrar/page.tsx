'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export default function EntrarPage() {
  return (
    <Suspense fallback={null}>
      <EntrarForm />
    </Suspense>
  )
}

function EntrarForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const basePath = useWholesaleBasePath()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/wholesale/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(typeof json.error === 'string' ? json.error : 'Falha ao entrar.')
        return
      }
      router.push(searchParams.get('redirect') ?? wholesaleHref(basePath, '/'))
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-sm mx-auto py-10 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Entrar</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">E-mail</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary" />
        </div>
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">Senha</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary" />
        </div>
        <button type="submit" disabled={loading} className="w-full py-2.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      <p className="text-sm text-text-muted text-center">
        Ainda não tem conta? <Link href={wholesaleHref(basePath, '/cadastro')} className="text-brand font-medium hover:underline">Cadastre-se</Link>
      </p>
    </div>
  )
}
