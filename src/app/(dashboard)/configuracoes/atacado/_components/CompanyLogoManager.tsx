'use client'

/**
 * Logo do catálogo de atacado — reaproveita 100% o Media Hub já usado por
 * produtos (mesmo bucket público, mesmas rotas /api/media/**), só com
 * entity_type='company' e role='logo' (singular por empresa — ver
 * migration 202609050900). Variante de arquivo único de
 * produtos/_components/product-media.tsx.
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import Image from 'next/image'
import { ImagePlus, ImageOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ResolvedMedia {
  usage_id: number
  public_id: string
  role: string
  url: string
  alt_text: string | null
}

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp'

export function CompanyLogoManager({ companyId }: { companyId: number }) {
  const [logo, setLogo] = useState<ResolvedMedia | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function loadLogo() {
    try {
      const res = await fetch(`/api/media?entity_type=company&entity_id=${companyId}`)
      const json = await res.json()
      const items: ResolvedMedia[] = res.ok ? (json.media ?? []) : []
      setLogo(items.find((m) => m.role === 'logo') ?? null)
    } catch {
      setLogo(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLogo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function upload(file: File) {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('visibility', 'public')

      const uploadRes = await fetch('/api/media', { method: 'POST', body: formData })
      const uploadJson = await uploadRes.json()
      if (!uploadRes.ok) {
        toast.error('Erro ao enviar logo', { description: uploadJson.error })
        return
      }

      // Logo é role singular — remove o vínculo anterior antes de criar o
      // novo (mesma regra de troca de produto principal, sem a RPC atômica
      // dedicada — frequência de uso baixa o suficiente pra não justificar).
      if (logo) {
        await fetch(`/api/media/${logo.public_id}/usages/${logo.usage_id}`, { method: 'DELETE' })
      }

      const linkRes = await fetch(`/api/media/${uploadJson.media.public_id}/usages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: 'company', entity_id: String(companyId), role: 'logo' }),
      })
      const linkJson = await linkRes.json()
      if (!linkRes.ok) {
        toast.error('Logo enviada, mas não foi possível vincular', { description: linkJson.error })
        return
      }

      toast.success('Logo atualizada!')
      await loadLogo()
    } catch {
      toast.error('Erro de rede ao enviar logo')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove() {
    if (!logo) return
    const confirmed = window.confirm('Remover a logo do catálogo?')
    if (!confirmed) return

    try {
      const res = await fetch(`/api/media/${logo.public_id}/usages/${logo.usage_id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json()
        toast.error('Erro ao remover logo', { description: json.error })
        return
      }
      setLogo(null)
      toast.success('Logo removida')
    } catch {
      toast.error('Erro de rede ao remover logo')
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) upload(file)
  }

  if (loading) return <p className="text-sm text-text-muted">Carregando logo...</p>

  return (
    <div className="flex items-center gap-4">
      <div className="w-20 h-20 rounded-lg border border-border bg-bg-overlay flex items-center justify-center overflow-hidden shrink-0">
        {logo ? (
          <Image src={logo.url} alt={logo.alt_text ?? 'Logo'} width={80} height={80} className="w-full h-full object-contain" />
        ) : (
          <ImageOff className="w-6 h-6 text-text-muted" />
        )}
      </div>
      <div className="flex gap-2">
        <input ref={inputRef} type="file" accept={ACCEPTED_MIME} className="hidden" onChange={handleFileChange} />
        <Button type="button" variant="secondary" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
          <ImagePlus className="w-3.5 h-3.5" />
          {logo ? 'Trocar logo' : 'Enviar logo'}
        </Button>
        {logo && (
          <Button type="button" variant="ghost" size="sm" onClick={handleRemove}>
            <Trash2 className="w-3.5 h-3.5 text-error" />
          </Button>
        )}
      </div>
    </div>
  )
}
