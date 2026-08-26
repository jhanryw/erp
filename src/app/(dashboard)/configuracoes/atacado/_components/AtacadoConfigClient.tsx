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
}

export function AtacadoConfigClient({ companyId, initialSettings, initialBanners }: Props) {
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
        body: JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar', { description: typeof json.error === 'string' ? json.error : 'Verifique os campos.' })
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

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Store className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Atacado — Catálogo Online</h2>
            <p className="text-sm text-text-muted">Configure o catálogo público de atacado</p>
          </div>
        </div>
      </div>

      <Card className="p-5 space-y-1">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Status</h3>
        <Checkbox label="Catálogo público ativo" checked={settings.catalogActive} onChange={(v) => patch({ catalogActive: v })} />
        <p className="text-xs text-text-muted mt-1">
          Quando desativado, o catálogo mostra só a logo e uma mensagem informando que está temporariamente indisponível.
        </p>
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Identidade</h3>
        <CompanyLogoManager companyId={companyId} />
        <Input
          label="Nome exibido no catálogo"
          placeholder="Atacado"
          value={settings.displayName ?? ''}
          onChange={(e) => patch({ displayName: e.target.value })}
        />
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">WhatsApp</h3>
        <Input
          label="Número para recebimento dos pedidos"
          placeholder="84 99999-9999"
          value={settings.whatsappPhone ?? ''}
          onChange={(e) => patch({ whatsappPhone: e.target.value })}
        />
        <p className="text-xs text-text-muted -mt-2">
          Precisa ser um número de celular com WhatsApp (DDD + 9 dígitos) — número fixo não recebe mensagens do catálogo.
        </p>
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Pedido</h3>
        <Input
          label="Pedido mínimo (R$)"
          type="number"
          step="0.01"
          min="0"
          value={settings.minimumOrderAmount}
          onChange={(e) => patch({ minimumOrderAmount: Number(e.target.value) })}
        />
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
        <Input
          label="Pixel ID"
          placeholder="Ex.: 1234567890123456"
          value={settings.pixelId ?? ''}
          onChange={(e) => patch({ pixelId: e.target.value })}
          disabled={!settings.pixelEnabled}
        />
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving}>Salvar configuração</Button>
      </div>

      <Card className="p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Banners da vitrine</h3>
          <p className="text-xs text-text-muted">Aparecem entre a busca/categorias e a lista de produtos. WEBP, JPG ou PNG.</p>
        </div>
        <BannerManager initialBanners={initialBanners} />
      </Card>
    </div>
  )
}
