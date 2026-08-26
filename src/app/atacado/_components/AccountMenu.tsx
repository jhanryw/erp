'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { User } from 'lucide-react'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

interface Props {
  customerName: string | null
}

export function AccountMenu({ customerName }: Props) {
  const router = useRouter()
  const basePath = useWholesaleBasePath()

  async function handleLogout() {
    await fetch('/api/wholesale/auth/logout', { method: 'POST' })
    router.push(wholesaleHref(basePath, '/'))
    router.refresh()
  }

  if (!customerName) {
    return (
      <Link href={wholesaleHref(basePath, '/entrar')} className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
        <User className="w-5 h-5" />
        <span className="hidden sm:inline">Entrar</span>
      </Link>
    )
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <Link href={wholesaleHref(basePath, '/pedidos')} className="text-text-secondary hover:text-text-primary transition-colors hidden sm:inline">
        Meus pedidos
      </Link>
      <span className="text-text-primary font-medium hidden sm:inline">{customerName.split(' ')[0]}</span>
      <button onClick={handleLogout} className="text-text-muted hover:text-text-primary text-xs underline">
        Sair
      </button>
    </div>
  )
}
