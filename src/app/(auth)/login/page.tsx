'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Eye, EyeOff, Gem, Lock, Mail } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
})

type LoginForm = z.infer<typeof loginSchema>

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get('redirect') ?? '/'
  const [showPassword, setShowPassword] = useState(false)
  const supabase = createClient()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) })

  async function onSubmit(data: LoginForm) {
    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })

    if (error) {
      toast.error('Credenciais inválidas', {
        description: 'Verifique seu email e senha e tente novamente.',
      })
      return
    }

    router.push(redirect)
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-bg-root flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand mb-4">
            <Gem className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-text-primary">Santtorini ERP</h1>
          <p className="text-sm text-text-muted mt-1">Acesso restrito à equipe interna</p>
        </div>

        {/* Form */}
        <div className="card p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Entrar na sua conta</h2>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="seu@email.com"
              prefix={<Mail className="w-4 h-4" />}
              error={errors.email?.message}
              autoComplete="email"
              {...register('email')}
            />

            <div>
              <Input
                label="Senha"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                prefix={<Lock className="w-4 h-4" />}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="hover:text-text-secondary transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
                error={errors.password?.message}
                autoComplete="current-password"
                {...register('password')}
              />
              <div className="flex justify-end mt-1.5">
                <Link
                  href="/recuperar-acesso"
                  className="text-xs text-text-muted hover:text-accent transition-colors"
                >
                  Esqueceu a senha?
                </Link>
              </div>
            </div>

            <Button type="submit" className="w-full" loading={isSubmitting} size="lg">
              Entrar
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-text-muted mt-6">
          © {new Date().getFullYear()} Santtorini. Uso interno.
        </p>
      </div>
    </div>
  )
}
