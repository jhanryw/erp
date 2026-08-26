import type { Metadata } from 'next'
import Link from 'next/link'
import { CartProvider } from './_lib/CartContext'
import { HeaderCartLink } from './_components/HeaderCartLink'
import { AccountMenu } from './_components/AccountMenu'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'

// Site de Atacado (Fase 8) — canal público, voltado a clientes externos.
// Diferente do resto do ERP (`noindex, nofollow` no layout raiz), este
// subtree é o único ponto do projeto que deve ser indexável — seção 35
// do pedido (SEO básico).
export const metadata: Metadata = {
  title: { default: 'Santtorini Atacado', template: '%s | Santtorini Atacado' },
  description: 'Compre no atacado direto da Santtorini — catálogo, preços e disponibilidade em tempo real.',
  robots: 'index, follow',
}

export default async function AtacadoLayout({ children }: { children: React.ReactNode }) {
  const session = await getWholesaleCustomerSession()

  return (
    <CartProvider>
      <div className="min-h-screen flex flex-col bg-bg-root">
        <header className="border-b border-border bg-bg-card sticky top-0 z-40">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <Link href="/atacado" className="text-lg font-bold tracking-tight text-text-primary">
              Santtorini <span className="text-brand">Atacado</span>
            </Link>
            <div className="flex items-center gap-4">
              <AccountMenu customerName={session?.name ?? null} />
              <HeaderCartLink />
            </div>
          </div>
        </header>

        <main className="flex-1">
          <div className="max-w-6xl mx-auto px-4 py-6">
            {children}
          </div>
        </main>

        <footer className="border-t border-border py-6 mt-10">
          <div className="max-w-6xl mx-auto px-4 text-xs text-text-muted text-center">
            Santtorini Atacado — vendas B2B. Ambiente de vendas integrado ao ERP Santtorini.
          </div>
        </footer>
      </div>
    </CartProvider>
  )
}
