'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { CompanyLogoManager } from './CompanyLogoManager'
import { BannerManager } from './BannerManager'
import { CategoryCoverManager } from './CategoryCoverManager'
import { SiteTextsCard } from './SiteTextsCard'
import { AnnouncementsManager } from './AnnouncementsManager'
import { FooterCard, WhatsAppSocialCard } from './SiteChromeCards'
import type { WholesaleSiteSettings } from '@/services/wholesale/settings'
import type { WholesaleBanner } from '@/services/wholesale/banners'

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer py-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
      />
      {label}
    </label>
  )
}

interface Props {
  companyId: number
  initialSettings: WholesaleSiteSettings
  initialBanners: WholesaleBanner[]
  logoUrl: string | null
}

const TABS = [
  { id: 'identidade', label: 'Identidade e textos' },
  { id: 'banners', label: 'Banners' },
  { id: 'categorias', label: 'Categorias' },
  { id: 'anuncios', label: 'Barra de anúncios' },
  { id: 'rodape', label: 'Rodapé e loja' },
  { id: 'whatsapp', label: 'WhatsApp e redes' },
] as const
type TabId = (typeof TABS)[number]['id']

export function AtacadoConfigClient({ companyId, initialSettings, initialBanners, logoUrl }: Props) {
  const [tab, setTab] = useState<TabId>('identidade')
  const [settings, setSettings] = useState<WholesaleSiteSettings>(initialSettings)
  const [saving, setSaving] = useState(false)

  function patch(fields: Partial<WholesaleSiteSettings>) {
    setSettings((s) => ({ ...s, ...fields }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/configuracoes/atacado', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Links em branco (linha adicionada e não preenchida) não são enviados.
        body: JSON.stringify({
          ...settings,
          chrome: {
            ...settings.chrome,
            footer: {
              ...settings.chrome.footer,
              navigationLinks: settings.chrome.footer.navigationLinks.filter((l) => l.label.trim() || l.url.trim()),
              supportLinks: settings.chrome.footer.supportLinks.filter((l) => l.label.trim() || l.url.trim()),
              legalLinks: settings.chrome.footer.legalLinks.filter((l) => l.label.trim() || l.url.trim()),
            },
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        const detail = typeof json.error === 'string' ? json.error : (json.error?.fieldErrors ? Object.values(json.error.fieldErrors as Record<string, string[]>).flat()[0] : null)
        toast.error('Erro ao salvar', { description: detail ?? 'Verifique os campos.' })
        return
      }
      setSettings(json.settings)
      toast.success('Configuração do catálogo salva!')
    } catch {
      toast.error('Erro de rede ao salvar')
    } finally {
      setSaving(false)
    }
  }

  const saveBar = (
    <div className="flex justify-end">
      <Button onClick={handleSave} loading={saving}>Salvar configuração</Button>
    </div>
  )

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Store className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Atacado — Personalização do site</h2>
            <p className="text-sm text-text-muted">Tudo aqui vale no site público assim que você salva, sem novo deploy.</p>
          </div>
        </div>
      </div>

      <div role="tablist" aria-label="Seções da personalização" className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {TABS.map((t) => (
          <button
            key={t.id} role="tab" type="button" aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${tab === t.id ? 'bg-brand text-white' : 'text-text-muted hover:bg-bg-overlay hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'identidade' && (
        <div role="tabpanel" className="space-y-5">
          <Card className="p-5 space-y-1">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Status</h3>
            <Checkbox label="Catálogo público ativo" checked={settings.catalogActive} onChange={(v) => patch({ catalogActive: v })} />
            <p className="text-xs text-text-muted mt-1">Quando desativado, o catálogo mostra só a logo e uma mensagem informando que está temporariamente indisponível.</p>
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Identidade</h3>
            <CompanyLogoManager companyId={companyId} />
            <Input label="Nome exibido no catálogo" placeholder="Atacado" value={settings.displayName ?? ''} onChange={(e) => patch({ displayName: e.target.value })} />
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Pedido</h3>
            <Input label="Pedido mínimo (R$)" type="number" step="0.01" min="0" value={settings.minimumOrderAmount} onChange={(e) => patch({ minimumOrderAmount: Number(e.target.value) })} />
            <p className="text-xs text-text-muted">É a única fonte do valor mínimo — a barra de anúncios e os textos não o alteram.</p>
          </Card>

          <Card className="p-5 space-y-1">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Catálogo</h3>
            <Checkbox label="Mostrar produtos sem estoque" checked={settings.showOutOfStock} onChange={(v) => patch({ showOutOfStock: v })} />
            <Checkbox label="Mostrar quantidade disponível" checked={settings.showStockQuantity} onChange={(v) => patch({ showStockQuantity: v })} />
            <Checkbox label="Mostrar busca" checked={settings.showSearch} onChange={(v) => patch({ showSearch: v })} />
            <Checkbox label="Mostrar categorias" checked={settings.showCategories} onChange={(v) => patch({ showCategories: v })} />
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Meta</h3>
            <Checkbox label="Ativar Meta Pixel" checked={settings.pixelEnabled} onChange={(v) => patch({ pixelEnabled: v })} />
            <Input label="Pixel ID" placeholder="Ex.: 1234567890123456" value={settings.pixelId ?? ''} onChange={(e) => patch({ pixelId: e.target.value })} disabled={!settings.pixelEnabled} />
          </Card>

          <SiteTextsCard texts={settings.texts} exclude={['footerText']} onChange={(texts) => patch({ texts })} />
          {saveBar}
        </div>
      )}

      {tab === 'banners' && (
        <div role="tabpanel" className="space-y-5">
          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Banners da vitrine</h3>
              <p className="text-xs text-text-muted">Aparecem no topo da página inicial. Cada banner aceita imagem desktop e mobile, textos opcionais e botão. WEBP, JPG ou PNG.</p>
            </div>
            <BannerManager initialBanners={initialBanners} />
          </Card>
        </div>
      )}

      {tab === 'categorias' && (
        <div role="tabpanel" className="space-y-5">
          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Fotos das categorias</h3>
              <p className="text-xs text-text-muted">Aparecem nos cards logo abaixo do banner. Só categorias com produtos visíveis no atacado são exibidas.</p>
            </div>
            <CategoryCoverManager />
          </Card>
          <Card className="p-5 space-y-2">
            <h3 className="text-sm font-semibold text-text-primary">Cores do mesmo modelo</h3>
            <p className="text-xs text-text-muted">Agrupe os produtos que são cores do mesmo modelo para o cliente alternar entre elas na página do produto.</p>
            <Link href="/configuracoes/atacado/cores"><Button type="button" variant="secondary" size="sm">Gerenciar grupos de cores</Button></Link>
          </Card>
        </div>
      )}

      {tab === 'anuncios' && (
        <div role="tabpanel" className="space-y-5">
          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Barra de anúncios</h3>
              <p className="text-xs text-text-muted">Faixa no topo do site. Várias mensagens alternam sozinhas; sem mensagens ativas a barra não aparece. O valor do pedido mínimo é o da aba Identidade — se citá-lo, mantenha o texto atualizado.</p>
            </div>
            <AnnouncementsManager intervalSeconds={settings.announcementIntervalSeconds} onIntervalChange={(announcementIntervalSeconds) => patch({ announcementIntervalSeconds })} />
          </Card>
          {saveBar}
        </div>
      )}

      {tab === 'rodape' && (
        <div role="tabpanel" className="space-y-5">
          <SiteTextsCard
            texts={settings.texts} only={['footerText']} onChange={(texts) => patch({ texts })}
            title="Descrição institucional" description="Breve texto da marca, exibido no rodapé ao lado da logo."
          />
          <FooterCard
            chrome={settings.chrome} onChange={(chrome) => patch({ chrome })}
            displayName={settings.displayName} logoUrl={logoUrl} description={settings.texts.footerText} whatsappPhone={settings.whatsappPhone}
          />
          {saveBar}
        </div>
      )}

      {tab === 'whatsapp' && (
        <div role="tabpanel" className="space-y-5">
          <WhatsAppSocialCard
            chrome={settings.chrome} onChange={(chrome) => patch({ chrome })}
            whatsappPhone={settings.whatsappPhone} onWhatsappPhoneChange={(whatsappPhone) => patch({ whatsappPhone })}
          />
          {saveBar}
        </div>
      )}
    </div>
  )
}
