'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { toast } from 'sonner'
import { ImagePlus, Trash2, ChevronUp, ChevronDown, Link2, Pencil, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WholesaleBanner, BannerLinkType } from '@/services/wholesale/banners'

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp'

interface CategoryOption { id: number; name: string; key: string }

function LinkEditor({
  link,
  onChange,
  categories,
}: {
  link: { type: BannerLinkType; categorySlug?: string; productId?: number; url?: string }
  onChange: (link: { type: BannerLinkType; categorySlug?: string; productId?: number; url?: string }) => void
  categories: CategoryOption[]
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 flex-1">
      <select
        value={link.type}
        onChange={(e) => onChange({ type: e.target.value as BannerLinkType })}
        className="text-xs rounded-lg border border-border bg-bg-input text-text-primary px-2 py-1.5"
      >
        <option value="none">Sem link</option>
        <option value="category">Categoria</option>
        <option value="product">Produto (ID)</option>
        <option value="url">URL externa</option>
      </select>

      {link.type === 'category' && (
        <select
          value={link.categorySlug ?? ''}
          onChange={(e) => onChange({ type: 'category', categorySlug: e.target.value })}
          className="text-xs rounded-lg border border-border bg-bg-input text-text-primary px-2 py-1.5 flex-1"
        >
          <option value="">Selecione uma categoria</option>
          {categories.map((c) => <option key={c.id} value={c.key}>{c.name}</option>)}
        </select>
      )}

      {link.type === 'product' && (
        <input
          type="number"
          placeholder="ID do produto"
          value={link.productId ?? ''}
          onChange={(e) => onChange({ type: 'product', productId: Number(e.target.value) || undefined })}
          className="text-xs rounded-lg border border-border bg-bg-input text-text-primary px-2 py-1.5 flex-1"
        />
      )}

      {link.type === 'url' && (
        <input
          type="text"
          placeholder="https://..."
          value={link.url ?? ''}
          onChange={(e) => onChange({ type: 'url', url: e.target.value })}
          className="text-xs rounded-lg border border-border bg-bg-input text-text-primary px-2 py-1.5 flex-1"
        />
      )}
    </div>
  )
}

type LinkValue = { type: BannerLinkType; categorySlug?: string; productId?: number; url?: string }

const inputCls = 'w-full text-xs rounded-lg border border-border bg-bg-input text-text-primary px-2 py-1.5'

/** Envia uma imagem pública ao Media Hub e devolve o `public_id` (ou `null` após avisar o erro). */
async function uploadPublicImage(file: File): Promise<string | null> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('visibility', 'public')
  const res = await fetch('/api/media', { method: 'POST', body: formData })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    toast.error('Erro ao enviar imagem', { description: json.error })
    return null
  }
  return json.media.public_id as string
}

function BannerEditor({
  banner,
  categories,
  onSaved,
}: {
  banner: WholesaleBanner
  categories: CategoryOption[]
  onSaved: (banner: WholesaleBanner) => void
}) {
  const [title, setTitle] = useState(banner.title ?? '')
  const [subtitle, setSubtitle] = useState(banner.subtitle ?? '')
  const [ctaLabel, setCtaLabel] = useState(banner.ctaLabel ?? '')
  const [showText, setShowText] = useState(banner.showText)
  const [link, setLink] = useState<LinkValue>(banner.link)
  const [saving, setSaving] = useState(false)
  const desktopRef = useRef<HTMLInputElement>(null)
  const mobileRef = useRef<HTMLInputElement>(null)

  async function patch(body: Record<string, unknown>, okMessage: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/configuracoes/atacado/banners/${banner.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar banner', { description: typeof json.error === 'string' ? json.error : undefined })
        return
      }
      onSaved(json.banner)
      toast.success(okMessage)
    } catch {
      toast.error('Erro de rede ao salvar banner')
    } finally {
      setSaving(false)
    }
  }

  async function replaceImage(file: File | undefined, field: 'mediaPublicId' | 'mobileMediaPublicId') {
    if (!file) return
    setSaving(true)
    const publicId = await uploadPublicImage(file)
    setSaving(false)
    if (publicId) await patch({ [field]: publicId }, 'Imagem atualizada')
  }

  return (
    <div className="space-y-3 p-3 rounded-lg border border-border bg-bg-card">
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="space-y-1 text-xs text-text-muted">
          Título (opcional)
          <input className={inputCls} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          Texto do botão (opcional)
          <input className={inputCls} maxLength={30} value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Ex.: Ver coleção" />
        </label>
        <label className="space-y-1 text-xs text-text-muted sm:col-span-2">
          Subtítulo (opcional)
          <input className={inputCls} maxLength={160} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} className="w-3.5 h-3.5 accent-brand" />
        Exibir textos sobre a imagem (desmarque se a própria imagem já contém as informações)
      </label>

      <div>
        <p className="text-xs text-text-muted mb-1">Destino do clique (o botão só aparece quando há destino)</p>
        <LinkEditor link={link} onChange={setLink} categories={categories} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input ref={desktopRef} type="file" accept={ACCEPTED_MIME} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void replaceImage(f, 'mediaPublicId') }} />
        <input ref={mobileRef} type="file" accept={ACCEPTED_MIME} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void replaceImage(f, 'mobileMediaPublicId') }} />
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => desktopRef.current?.click()}>
          <ImagePlus className="w-3.5 h-3.5" /> Trocar imagem desktop
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => mobileRef.current?.click()}>
          <Smartphone className="w-3.5 h-3.5" /> {banner.mobileImageUrl ? 'Trocar imagem mobile' : 'Enviar imagem mobile'}
        </Button>
        {banner.mobileImageUrl && (
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => patch({ mobileMediaPublicId: null }, 'Imagem mobile removida')}>
            Remover mobile
          </Button>
        )}
      </div>
      <p className="text-[11px] text-text-muted">Tamanhos ideais: desktop 1920×640 px (proporção 3:1) · mobile 1080×1350 px (4:5). Sem imagem mobile, a desktop é recortada ao centro.</p>

      <div className="flex justify-end">
        <Button
          type="button" size="sm" loading={saving}
          onClick={() => {
            if (link.type === 'category' && !link.categorySlug) return void toast.error('Selecione a categoria de destino.')
            if (link.type === 'product' && !link.productId) return void toast.error('Informe o ID do produto de destino.')
            if (link.type === 'url' && !link.url) return void toast.error('Informe a URL de destino.')
            void patch({ title, subtitle, ctaLabel, showText, link }, 'Banner salvo')
          }}
        >
          Salvar alterações
        </Button>
      </div>
    </div>
  )
}

export function BannerManager({ initialBanners }: { initialBanners: WholesaleBanner[] }) {
  const [banners, setBanners] = useState<WholesaleBanner[]>(initialBanners)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [uploading, setUploading] = useState(false)
  const [newLink, setNewLink] = useState<{ type: BannerLinkType; categorySlug?: string; productId?: number; url?: string }>({ type: 'none' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/configuracoes/atacado/categorias')
      .then((r) => r.json())
      .then((json) => setCategories(json.categories ?? []))
      .catch(() => setCategories([]))
  }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    if (newLink.type === 'category' && !newLink.categorySlug) {
      toast.error('Selecione a categoria de destino antes de enviar a imagem.')
      return
    }
    if (newLink.type === 'product' && !newLink.productId) {
      toast.error('Informe o ID do produto de destino antes de enviar a imagem.')
      return
    }
    if (newLink.type === 'url' && !newLink.url) {
      toast.error('Informe a URL de destino antes de enviar a imagem.')
      return
    }

    setUploading(true)
    try {
      const publicId = await uploadPublicImage(file)
      if (!publicId) return

      const createRes = await fetch('/api/configuracoes/atacado/banners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaPublicId: publicId, link: newLink }),
      })
      const createJson = await createRes.json()
      if (!createRes.ok) {
        toast.error('Imagem enviada, mas não foi possível criar o banner', { description: typeof createJson.error === 'string' ? createJson.error : undefined })
        return
      }

      setBanners((prev) => [...prev, createJson.banner])
      setNewLink({ type: 'none' })
      setEditingId(createJson.banner.id)
      toast.success('Banner adicionado! Complete os textos e a imagem mobile, se quiser.')
    } catch {
      toast.error('Erro de rede ao enviar banner')
    } finally {
      setUploading(false)
    }
  }

  async function toggleActive(banner: WholesaleBanner) {
    const res = await fetch(`/api/configuracoes/atacado/banners/${banner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !banner.isActive }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao atualizar banner', { description: typeof json.error === 'string' ? json.error : undefined })
      return
    }
    setBanners((prev) => prev.map((b) => (b.id === banner.id ? json.banner : b)))
  }

  async function handleDelete(banner: WholesaleBanner) {
    const confirmed = window.confirm('Excluir este banner?')
    if (!confirmed) return

    const res = await fetch(`/api/configuracoes/atacado/banners/${banner.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const json = await res.json()
      toast.error('Erro ao excluir banner', { description: typeof json.error === 'string' ? json.error : undefined })
      return
    }
    setBanners((prev) => prev.filter((b) => b.id !== banner.id))
    toast.success('Banner excluído')
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= banners.length) return

    const reordered = [...banners]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    setBanners(reordered)

    const res = await fetch('/api/configuracoes/atacado/banners/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bannerIds: reordered.map((b) => b.id) }),
    })
    if (!res.ok) {
      toast.error('Erro ao reordenar banners')
      setBanners(banners)
    }
  }

  return (
    <div className="space-y-3">
      {banners.length === 0 && <p className="text-xs text-text-muted italic">Nenhum banner cadastrado ainda.</p>}

      {banners.map((banner, index) => (
        <div key={banner.id} className="space-y-2">
        <div className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg-overlay">
          <div className="w-20 h-12 rounded-md overflow-hidden bg-bg-card shrink-0 relative">
            {banner.imageUrl && <Image src={banner.imageUrl} alt={banner.altText ?? 'Banner'} fill className="object-cover" />}
          </div>

          <div className="flex-1 min-w-0 flex items-center gap-2 text-xs text-text-muted">
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              {banner.title && <strong className="text-text-primary mr-2">{banner.title}</strong>}
              {banner.mobileImageUrl && <span className="mr-2">📱</span>}
              {banner.link.type === 'none' && 'Sem link'}
              {banner.link.type === 'category' && `Categoria: ${banner.link.categorySlug}`}
              {banner.link.type === 'product' && `Produto #${banner.link.productId}`}
              {banner.link.type === 'url' && banner.link.url}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => move(index, -1)} disabled={index === 0} className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30">
              <ChevronUp className="w-4 h-4" />
            </button>
            <button onClick={() => move(index, 1)} disabled={index === banners.length - 1} className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30">
              <ChevronDown className="w-4 h-4" />
            </button>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer px-1">
              <input type="checkbox" checked={banner.isActive} onChange={() => toggleActive(banner)} className="w-3.5 h-3.5 accent-brand" />
              Ativo
            </label>
            <button onClick={() => setEditingId(editingId === banner.id ? null : banner.id)} aria-label="Editar banner" className="p-1 text-text-muted hover:text-text-primary">
              <Pencil className="w-4 h-4" />
            </button>
            <button onClick={() => handleDelete(banner)} className="p-1 text-text-muted hover:text-error">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
        {editingId === banner.id && (
          <BannerEditor
            key={`${banner.id}-${banner.mobileImageUrl ?? ''}-${banner.imageUrl}`}
            banner={banner}
            categories={categories}
            onSaved={(updated) => setBanners((prev) => prev.map((b) => (b.id === updated.id ? updated : b)))}
          />
        )}
        </div>
      ))}

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2 border-t border-border">
        <LinkEditor link={newLink} onChange={setNewLink} categories={categories} />
        <input ref={inputRef} type="file" accept={ACCEPTED_MIME} className="hidden" onChange={handleFileChange} />
        <Button type="button" variant="secondary" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
          <ImagePlus className="w-3.5 h-3.5" />
          Adicionar banner
        </Button>
      </div>
    </div>
  )
}
