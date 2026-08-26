import { MessageCircle } from 'lucide-react'
import { buildWhatsAppContactUrl } from '@/lib/wholesale/whatsapp'

/** Catálogo desativado (seção 26 do pedido) — nunca mostra produto/banner, nunca login. */
export function CatalogInactiveNotice({ displayName, whatsappPhone }: { displayName: string | null; whatsappPhone: string | null }) {
  const contactUrl = buildWhatsAppContactUrl(whatsappPhone, `Olá! Gostaria de saber mais sobre o catálogo${displayName ? ` da ${displayName}` : ''}.`)

  return (
    <div className="py-24 text-center space-y-4 max-w-md mx-auto px-4">
      <p className="text-gray-500">
        O catálogo{displayName ? ` da ${displayName}` : ''} está temporariamente indisponível. Volte em breve.
      </p>
      {contactUrl && (
        <a
          href={contactUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#25D366] text-white text-sm font-medium hover:brightness-95 transition-all"
        >
          <MessageCircle className="w-4 h-4" />
          Falar pelo WhatsApp
        </a>
      )}
    </div>
  )
}
