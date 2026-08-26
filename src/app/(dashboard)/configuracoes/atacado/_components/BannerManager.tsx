'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { toast } from 'sonner'
import { ImagePlus, Trash2, ChevronUp, ChevronDown, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WholesaleBanner, BannerLinkType } from '@/services/wholesale/banners'

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp'

interface CategoryOption { id: number; name: string; slug: string }

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
          {categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
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

export function BannerManager({ initialBanners }: { initialBanners: WholesaleBanner[] }) {
  const [banners, setBanners] = useState<WholesaleBanner[]>(initialBanners)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [uploading, setUploading] = useState(false)
  const [newLink, setNewLink] = useState<{ type: BannerLinkType; categorySlug?: string; productId?: number; url?: string }>({ type: 'none' })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/categorias')
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
      const formData = new FormData()
      formData.append('file', file)
      formData.append('visibility', 'public')

      const uploadRes = await fetch('/api/media', { method: 'POST', body: formData })
      const uploadJson = await uploadRes.json()
      if (!uploadRes.ok) {
        toast.error('Erro ao enviar imagem', { description: uploadJson.error })
        return
      }

      const createRes = await fetch('/api/configuracoes/atacado/banners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaPublicId: uploadJson.media.public_id, link: newLink }),
      })
      const createJson = await createRes.json()
      if (!createRes.ok) {
        toast.error('Imagem enviada, mas não foi possível criar o banner', { description: typeof createJson.error === 'string' ? createJson.error : undefined })
        return
      }

      setBanners((prev) => [...prev, createJson.banner])
      setNewLink({ type: 'none' })
      toast.success('Banner adicionado!')
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
        <div key={banner.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg-overlay">
          <div className="w-20 h-12 rounded-md overflow-hidden bg-bg-card shrink-0 relative">
            {banner.imageUrl && <Image src={banner.imageUrl} alt={banner.altText ?? 'Banner'} fill className="object-cover" />}
          </div>

          <div className="flex-1 min-w-0 flex items-center gap-2 text-xs text-text-muted">
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
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
            <button onClick={() => handleDelete(banner)} className="p-1 text-text-muted hover:text-error">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
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
