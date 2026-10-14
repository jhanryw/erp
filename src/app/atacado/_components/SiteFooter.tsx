import Image from 'next/image'
import Link from 'next/link'
import { Clock, Instagram, MapPin, MessageCircle } from 'lucide-react'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import type { ResolvedSiteChrome, LinkItem } from '@/services/wholesale/siteChrome'
import type { StoreInfo } from '@/services/wholesale/storeInfo'

export interface SiteFooterProps {
  basePath: string
  companyName: string
  logoUrl: string | null
  /** Descrição institucional (texts.footerText), já como linhas. */
  description: string[]
  chrome: ResolvedSiteChrome
  store: StoreInfo
  /** Há nome da loja digitado/cadastrado? (nome herdado do displayName sozinho não abre o bloco "Nossa loja"). */
  hasExplicitStoreName: boolean
  /** Link wa.me para atendimento (o MESMO número do carrinho), ou null se não configurado. */
  whatsappUrl: string | null
  year: number
  /** Catálogo desativado: só marca e copyright. */
  compact?: boolean
}

const external = (url: string) => /^https?:\/\//i.test(url)

function FooterLink({ link, basePath }: { link: LinkItem; basePath: string }) {
  const cls = 'text-sm text-gray-700 underline-offset-2 hover:text-gray-900 hover:underline'
  return external(link.url)
    ? <a href={link.url} target="_blank" rel="noopener noreferrer" className={cls}>{link.label}</a>
    : <Link href={wholesaleHref(basePath, link.url)} className={cls}>{link.label}</Link>
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-900">{title}</h2>
      {children}
    </section>
  )
}

/**
 * Rodapé institucional. Componente puro (sem I/O): usado no site e na prévia do ERP. Campo vazio nunca gera
 * linha nem bloco; seção desligada no ERP não aparece. Todo texto é renderizado como texto (sem HTML).
 */
export function SiteFooter({ basePath, companyName, logoUrl, description, chrome, store, hasExplicitStoreName, whatsappUrl, year, compact = false }: SiteFooterProps) {
  const s = chrome.footer.sections
  const home = wholesaleHref(basePath, '/')

  const navLinks: LinkItem[] = [
    { label: 'Início', url: '/' },
    { label: 'Produtos', url: '/#produtos' },
    { label: 'Categorias', url: '/#categorias' },
    { label: 'Carrinho', url: '/carrinho' },
    ...chrome.footer.navigationLinks,
  ]

  const hasDescription = description.some((l) => l.trim() !== '')
  const showBrand = !compact && s.brand && (logoUrl !== null || hasDescription)
  const showNav = !compact && s.navigation
  const hasSupport = !!(whatsappUrl || chrome.social.instagramUrl || chrome.footer.supportLinks.length > 0 || chrome.footer.hours)
  const showSupport = !compact && s.support && hasSupport
  const showStore = !compact && s.store && !!(store.legalName || store.cnpj || store.addressLine || store.city || store.mapsUrl || hasExplicitStoreName)
  const columns = [showBrand, showNav, showSupport, showStore].filter(Boolean).length
  const showLegal = s.legal || compact
  const location = [store.city, store.state].filter(Boolean).join(' / ')

  return (
    <footer className="mt-10 border-t border-gray-200 bg-gray-50 pb-24 text-gray-800 lg:pb-20" aria-label="Rodapé">
      {columns > 0 && (
        <div className={`mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 ${columns >= 4 ? 'lg:grid-cols-4' : columns === 3 ? 'lg:grid-cols-3' : ''}`}>
          {showBrand && (
            <Column title="Marca">
              {logoUrl && (
                <Link href={home} className="relative block h-10 w-40">
                  <Image src={logoUrl} alt={companyName || 'Logo'} fill sizes="160px" className="object-contain object-left" />
                </Link>
              )}
              {hasDescription && <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700">{description.join('\n')}</p>}
            </Column>
          )}

          {showNav && (
            <Column title="Navegação">
              <ul className="space-y-2">
                {navLinks.map((l, i) => <li key={`${l.url}-${i}`}><FooterLink link={l} basePath={basePath} /></li>)}
              </ul>
            </Column>
          )}

          {showSupport && (
            <Column title="Atendimento">
              <ul className="space-y-2">
                {whatsappUrl && (
                  <li>
                    <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-gray-700 underline-offset-2 hover:text-gray-900 hover:underline">
                      <MessageCircle aria-hidden className="h-4 w-4" /> WhatsApp
                    </a>
                  </li>
                )}
                {chrome.social.instagramUrl && (
                  <li>
                    <a href={chrome.social.instagramUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-gray-700 underline-offset-2 hover:text-gray-900 hover:underline">
                      <Instagram aria-hidden className="h-4 w-4" /> Instagram
                    </a>
                  </li>
                )}
                {chrome.footer.supportLinks.map((l, i) => <li key={`${l.url}-${i}`}><FooterLink link={l} basePath={basePath} /></li>)}
                {chrome.footer.hours && (
                  <li className="flex items-start gap-2 text-sm text-gray-700">
                    <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> <span>{chrome.footer.hours}</span>
                  </li>
                )}
              </ul>
            </Column>
          )}

          {showStore && (
            <Column title="Nossa loja">
              <address className="space-y-1 text-sm not-italic leading-relaxed text-gray-700">
                {(store.tradeName || store.legalName) && <p className="font-medium text-gray-900">{store.tradeName || store.legalName}</p>}
                {store.legalName && store.tradeName && store.legalName !== store.tradeName && <p>{store.legalName}</p>}
                {store.cnpj && <p>CNPJ: {store.cnpj}</p>}
                {store.addressLine && <p>{store.addressLine}</p>}
                {location && <p>{location}</p>}
                {store.mapsUrl && (
                  <p>
                    <a href={store.mapsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 underline underline-offset-2 hover:text-gray-900">
                      <MapPin aria-hidden className="h-4 w-4" /> Ver no Google Maps
                    </a>
                  </p>
                )}
              </address>
            </Column>
          )}
        </div>
      )}

      {showLegal && (
        <div className={`border-gray-200 ${columns > 0 ? 'border-t' : ''}`}>
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-5 text-xs text-gray-600 sm:flex-row">
            <p>© {year} {companyName || 'Atacado'}. Todos os direitos reservados.</p>
            {!compact && chrome.footer.legalLinks.length > 0 && (
              <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                {chrome.footer.legalLinks.map((l, i) => <li key={`${l.url}-${i}`}><FooterLink link={l} basePath={basePath} /></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </footer>
  )
}
