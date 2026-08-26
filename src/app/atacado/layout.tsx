import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { CartProvider } from './_lib/CartContext'
import { WholesaleBasePathProvider } from './_lib/WholesaleBasePathContext'
import { HeaderCartLink } from './_components/HeaderCartLink'
import { CatalogInactiveNotice } from './_components/CatalogInactiveNotice'
import { MetaPixelLoader } from './_lib/MetaPixelLoader'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings, getWholesaleCompanyLogoUrl } from '@/services/wholesale/settings'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

// Site de Atacado (Fase 8) — canal público, voltado a clientes externos.
// Diferente do resto do ERP (`noindex, nofollow` no layout raiz), este
// subtree é o único ponto do projeto que deve ser indexável.
export const metadata: Metadata = {
  title: { default: 'Catálogo de Atacado', template: '%s | Catálogo de Atacado' },
  description: 'Catálogo de atacado — preços e disponibilidade em tempo real, pedido direto pelo WhatsApp.',
  robots: 'index, follow',
}

export default async function AtacadoLayout({ children }: { children: React.ReactNode }) {
  const basePath = getWholesaleBasePath()
  const tenant = await resolveWholesaleSiteTenant()
  const [settings, logoUrl] = tenant
    ? await Promise.all([getWholesaleSiteSettings(tenant.companyId), getWholesaleCompanyLogoUrl(tenant.companyId)])
    : [null, null]

  // Catálogo desativado (seção 26 do pedido): nunca produto/banner/login —
  // só logo, mensagem e WhatsApp. Ignora `children` de propósito — nenhuma
  // rota interna (carrinho, produto/[id]) deve vazar conteúdo enquanto
  // desativado.
  const inactive = !!tenant && !!settings && !settings.catalogActive

  return (
    <WholesaleBasePathProvider basePath={basePath}>
      <CartProvider>
        {settings?.pixelEnabled && settings.pixelId && (
          <MetaPixelLoader pixelEnabled={settings.pixelEnabled} pixelId={settings.pixelId} />
        )}
        <div className="min-h-screen flex flex-col bg-white">
          <header className="border-b border-gray-100 bg-white sticky top-0 z-40">
            <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
              <Link href={wholesaleHref(basePath, '/')} className="flex items-center gap-2 min-w-0">
                {logoUrl ? (
                  <span className="relative h-9 w-32 shrink-0">
                    <Image src={logoUrl} alt={settings?.displayName ?? 'Catálogo'} fill className="object-contain object-left" />
                  </span>
                ) : (
                  <span className="text-lg font-semibold tracking-tight text-gray-900 truncate">
                    {settings?.displayName ?? 'Catálogo'}
                  </span>
                )}
              </Link>
              {!inactive && <HeaderCartLink />}
            </div>
          </header>

          <main className="flex-1">
            {inactive ? (
              <CatalogInactiveNotice displayName={settings.displayName} whatsappPhone={settings.whatsappPhone} />
            ) : (
              <div className="max-w-6xl mx-auto px-4 py-6">{children}</div>
            )}
          </main>

          <footer className="border-t border-gray-100 py-6 mt-10">
            <div className="max-w-6xl mx-auto px-4 text-xs text-gray-400 text-center">
              {settings?.displayName ?? 'Atacado'} — vendas por atacado
            </div>
          </footer>
        </div>
      </CartProvider>
    </WholesaleBasePathProvider>
  )
}
