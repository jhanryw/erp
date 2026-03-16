'use client'

export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { ArrowLeft, Gem, Mail } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

const schema = z.object({
  email: z.string().email('Email inválido'),
})

export default function RecoverPage() {
  const [sent, setSent] = useState(false)
  const supabase = createClient()

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  async function onSubmit({ email }: FormData) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?type=recovery`,
    })

    if (error) {
      toast.error('Erro ao enviar email', { description: error.message })
      return
    }

    setSent(true)
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand mb-4">
            <Gem className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-text-primary">Recuperar Acesso</h1>
        </div>

        <div className="card p-6">
          {sent ? (
            <div className="text-center py-4 space-y-3">
              <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto">
                <Mail className="w-6 h-6 text-success" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary">Email enviado</h3>
              <p className="text-sm text-text-secondary">
                Verifique sua caixa de entrada para redefinir sua senha.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <p className="text-sm text-text-secondary">
                Informe seu email para receber o link de redefinição de senha.
              </p>
              <Input
                label="Email"
                type="email"
                placeholder="seu@email.com"
                prefix={<Mail className="w-4 h-4" />}
                error={errors.email?.message}
                {...register('email')}
              />
              <Button type="submit" className="w-full" loading={isSubmitting}>
                Enviar link
              </Button>
            </form>
          )}
        </div>

        <div className="flex justify-center mt-6">
          <Link
            href="/login"
            className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar ao login
          </Link>
        </div>
      </div>
    </div>
  )
}
