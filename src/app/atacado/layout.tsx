import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { CartProvider } from './_lib/CartContext'
import { WholesaleBasePathProvider } from './_lib/WholesaleBasePathContext'
import { HeaderCartLink } from './_components/HeaderCartLink'
import { HeaderSearch } from './_components/HeaderSearch'
import { CatalogInactiveNotice } from './_components/CatalogInactiveNotice'
import { MetaPixelLoader } from './_lib/MetaPixelLoader'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings, getWholesaleCompanyLogoUrl } from '@/services/wholesale/settings'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { resolveSiteTexts } from '@/services/wholesale/siteTexts'
import { DEFAULT_SITE_CHROME } from '@/services/wholesale/siteChrome'
import { getActiveAnnouncements } from '@/services/wholesale/announcements'
import { getFiscalProfile } from '@/services/wholesale/fiscalProfile'
import { resolveStoreInfo } from '@/services/wholesale/storeInfo'
import { buildWhatsAppContactUrl } from '@/lib/wholesale/whatsapp'
import { AnnouncementBar } from './_components/AnnouncementBar'
import { SiteFooter } from './_components/SiteFooter'
import { FloatingWhatsApp } from './_components/FloatingWhatsApp'

// Configuração/catálogo nunca vêm do cache de dados do Next.
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

// Site de Atacado (Fase 8) — canal público, voltado a clientes externos.
// Diferente do resto do ERP (`noindex, nofollow` no layout raiz), este
// subtree é o único ponto do projeto que deve ser indexável.
export const metadata: Metadata = {
  title: { default: 'Catálogo de Atacado', template: '%s | Catálogo de Atacado' },
  description: 'Catálogo de atacado — preços e disponibilidade em tempo real, pedido direto pelo WhatsApp.',
  robots: 'index, follow',
  // Marca Santtorini (monograma oficial já usado como ícone do app): arquivos estáticos em /public/icons —
  // públicos, sem autenticação (o middleware não intercepta .png) e iguais em qualquer host.
  icons: {
    icon: [
      { url: '/icons/atacado-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/atacado-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icons/atacado-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/atacado-180.png', sizes: '180x180', type: 'image/png' }],
  },
}

export default async function AtacadoLayout({ children }: { children: React.ReactNode }) {
  const basePath = getWholesaleBasePath()
  const tenant = await resolveWholesaleSiteTenant()
  const [settings, logoUrl, announcements, fiscal] = tenant
    ? await Promise.all([
        getWholesaleSiteSettings(tenant.companyId),
        getWholesaleCompanyLogoUrl(tenant.companyId),
        getActiveAnnouncements(tenant.companyId),
        getFiscalProfile(tenant.companyId),
      ])
    : [null, null, [], null]

  // Catálogo desativado (seção 26 do pedido): nunca produto/banner/login —
  // só logo, mensagem e WhatsApp. Ignora `children` de propósito — nenhuma
  // rota interna (carrinho, produto/[id]) deve vazar conteúdo enquanto
  // desativado.
  const texts = resolveSiteTexts(settings?.texts, settings?.displayName ?? null)
  const inactive = !!tenant && !!settings && !settings.catalogActive

  // Institucional: tudo vem de configuração do ERP (rodapé, loja, redes) e do MESMO número de WhatsApp do carrinho.
  // Configurações antigas/sem migration → padrões seguros (rodapé padrão, botão flutuante com mensagem padrão).
  const chrome = settings ? (settings.chrome ?? DEFAULT_SITE_CHROME) : undefined
  const companyName = settings?.displayName ?? ''
  const store = chrome ? resolveStoreInfo(chrome.store, fiscal, settings?.displayName ?? null) : null
  const whatsappUrl = settings && chrome ? buildWhatsAppContactUrl(settings.whatsappPhone, chrome.whatsappFloat.message) : null
  const description = settings?.texts.footerText ? settings.texts.footerText.split('\n') : []

  return (
    <WholesaleBasePathProvider basePath={basePath}>
      <CartProvider>
        {settings?.pixelEnabled && settings.pixelId && (
          <MetaPixelLoader pixelEnabled={settings.pixelEnabled} pixelId={settings.pixelId} />
        )}
        {/* O site público é SEMPRE claro: sem isto, texto sem cor explícita herdava o tema do ERP (claro sobre
            branco no modo escuro do sistema) e os controles nativos (select/input) viravam escuros. */}
        <div className="atacado-root min-h-screen flex flex-col bg-white text-gray-900" style={{ colorScheme: 'light' }}>
          {/* Sem mensagens ativas (ou sem migration) a barra simplesmente não existe. */}
          {!inactive && announcements.length > 0 && (
            <AnnouncementBar
              announcements={announcements.map(({ id, message, linkUrl, backgroundColor, textColor }) => ({ id, message, linkUrl, backgroundColor, textColor }))}
              intervalSeconds={settings?.announcementIntervalSeconds ?? 5}
            />
          )}
          <header className="border-b border-gray-100 bg-white sticky top-0 z-40">
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <Link href={wholesaleHref(basePath, '/')} className="order-1 flex items-center gap-2 min-w-0">
                {logoUrl ? (
                  <span className="relative h-10 w-36 shrink-0 sm:h-11 sm:w-40">
                    <Image src={logoUrl} alt={settings?.displayName ?? 'Catálogo'} fill sizes="160px" priority className="object-contain object-left" />
                  </span>
                ) : (
                  <span className="text-lg font-semibold tracking-tight text-gray-900 truncate">
                    {settings?.displayName ?? 'Catálogo'}
                  </span>
                )}
              </Link>
              {/* Mobile: busca na 2ª linha, largura total. Desktop: entre logo e carrinho. */}
              {!inactive && settings?.showSearch && (
                <div className="order-3 w-full sm:order-2 sm:w-auto sm:flex-1 sm:max-w-md sm:mx-auto">
                  <HeaderSearch />
                </div>
              )}
              {!inactive && (
                <div className="order-2 ml-auto sm:order-3 sm:ml-0">
                  <HeaderCartLink />
                </div>
              )}
            </div>
          </header>

          <main className="flex-1">
            {inactive ? (
              <CatalogInactiveNotice displayName={settings.displayName} whatsappPhone={settings.whatsappPhone} />
            ) : (
              <div className="max-w-6xl mx-auto px-4 py-6">{children}</div>
            )}
          </main>

          {chrome && store && (
            <SiteFooter
              basePath={basePath}
              companyName={companyName}
              logoUrl={logoUrl}
              description={description}
              chrome={chrome}
              store={store}
              hasExplicitStoreName={!!(chrome.store.tradeName || chrome.store.legalName)}
              whatsappUrl={whatsappUrl}
              year={new Date().getFullYear()}
              compact={inactive}
            />
          )}

          {/* Só atendimento (não substitui a finalização). Só existe com o WhatsApp comercial configurado. */}
          {!inactive && whatsappUrl && chrome && (
            <FloatingWhatsApp url={whatsappUrl} enabledDesktop={chrome.whatsappFloat.enabledDesktop} enabledMobile={chrome.whatsappFloat.enabledMobile} />
          )}
        </div>
      </CartProvider>
    </WholesaleBasePathProvider>
  )
}
