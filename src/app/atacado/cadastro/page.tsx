'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function CadastroPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', cpf: '', cnpj: '' })
  const [loading, setLoading] = useState(false)

  function patch(fields: Partial<typeof form>) {
    setForm((f) => ({ ...f, ...fields }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.password.length < 8) {
      toast.error('Senha deve ter ao menos 8 caracteres.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/wholesale/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, email: form.email, phone: form.phone, password: form.password,
          cpf: form.cpf || null, cnpj: form.cnpj || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(typeof json.error === 'string' ? json.error : 'Falha ao criar conta.')
        return
      }
      toast.success('Conta criada!')
      router.push('/atacado')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-sm mx-auto py-10 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Criar conta</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label="Nome / Razão social *" value={form.name} onChange={(v) => patch({ name: v })} required />
        <Field label="E-mail *" type="email" value={form.email} onChange={(v) => patch({ email: v })} required />
        <Field label="Telefone *" value={form.phone} onChange={(v) => patch({ phone: v })} required />
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="CPF" value={form.cpf} onChange={(v) => patch({ cpf: v })} />
          <Field label="CNPJ" value={form.cnpj} onChange={(v) => patch({ cnpj: v })} />
        </div>
        <Field label="Senha *" type="password" value={form.password} onChange={(v) => patch({ password: v })} required />
        <button type="submit" disabled={loading} className="w-full py-2.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-50">
          {loading ? 'Criando conta...' : 'Criar conta'}
        </button>
      </form>
      <p className="text-sm text-text-muted text-center">
        Já tem conta? <Link href="/atacado/entrar" className="text-brand font-medium hover:underline">Entrar</Link>
      </p>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', required = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary block mb-1">{label}</label>
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
      />
    </div>
  )
}
