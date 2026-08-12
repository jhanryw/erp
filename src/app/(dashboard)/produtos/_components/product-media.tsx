'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import Image from 'next/image'
import { ImagePlus, ImageOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ── Types ──────────────────────────────────────────────────────────────────────
// Espelha o contrato JSON de GET /api/media?entity_type=&entity_id= — sem
// importar tipos do backend, mesmo padrão das outras telas de produto (que
// declaram seus próprios tipos locais casados com a resposta da API).

interface ResolvedMedia {
  usage_id: number
  public_id: string
  role: string
  position: number
  url: string
  alt_text: string | null
}

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp'

// ── Component ──────────────────────────────────────────────────────────────────
// Gerencia imagens do produto via Media Hub. Não vive dentro do <form> de
// edição de produto — é uma seção independente, com suas próprias chamadas
// de rede e seu próprio estado.

export function ProductMediaManager({ productId }: { productId: number }) {
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  // Produtos não está bloqueado: gerenciar mídia libera para todos os roles
  // (backend em ROLE_BY_ENTITY['product'] ajustado para 'usuario' também).
  const canManage = true

  const [items, setItems] = useState<ResolvedMedia[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadingPrimary, setUploadingPrimary] = useState(false)
  const [uploadingGallery, setUploadingGallery] = useState(false)

  const primaryInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)

  async function loadMedia() {
    try {
      const res = await fetch(`/api/media?entity_type=product&entity_id=${productId}`)
      const json = await res.json()
      setItems(res.ok ? (json.media ?? []) : [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMedia()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId])

  const primary = items.find((m) => m.role === 'primary') ?? null
  const gallery = items.filter((m) => m.role === 'gallery')

  // Upload da foto principal: sempre usa a troca atômica (POST .../primary),
  // funciona igual tanto para "enviar a primeira" quanto para "substituir a
  // atual" — remove a antiga e cria a nova na mesma transação no backend.
  async function uploadPrimary(file: File) {
    setUploadingPrimary(true)

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

      const primaryRes = await fetch(`/api/media/${uploadJson.media.public_id}/primary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'product',
          entity_id: String(productId),
        }),
      })
      const primaryJson = await primaryRes.json()

      if (!primaryRes.ok) {
        toast.error('Imagem enviada, mas não foi possível defini-la como principal', {
          description: primaryJson.error,
        })
        return
      }

      toast.success('Foto principal atualizada!')
      await loadMedia()
    } catch {
      toast.error('Erro de rede ao enviar imagem')
    } finally {
      setUploadingPrimary(false)
    }
  }

  async function uploadGallery(file: File) {
    setUploadingGallery(true)

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

      const linkRes = await fetch(`/api/media/${uploadJson.media.public_id}/usages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'product',
          entity_id: String(productId),
          role: 'gallery',
        }),
      })
      const linkJson = await linkRes.json()

      if (!linkRes.ok) {
        toast.error('Imagem enviada, mas não foi possível vincular ao produto', {
          description: linkJson.error,
        })
        return
      }

      toast.success('Imagem adicionada à galeria!')
      await loadMedia()
    } catch {
      toast.error('Erro de rede ao enviar imagem')
    } finally {
      setUploadingGallery(false)
    }
  }

  async function handleRemove(usage: ResolvedMedia) {
    const confirmed = window.confirm('Remover esta imagem do produto?')
    if (!confirmed) return

    try {
      const res = await fetch(`/api/media/${usage.public_id}/usages/${usage.usage_id}`, {
        method: 'DELETE',
      })
      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao remover imagem', { description: json.error })
        return
      }

      setItems((prev) => prev.filter((m) => m.usage_id !== usage.usage_id))
      toast.success('Imagem removida')
    } catch {
      toast.error('Erro de rede ao remover imagem')
    }
  }

  function handlePrimaryFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    uploadPrimary(file)
  }

  function handleGalleryFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    uploadGallery(file)
  }

  if (loading) {
    return (
      <div className="card p-6">
        <p className="text-sm text-text-muted">Carregando imagens...</p>
      </div>
    )
  }

  return (
    <div className="card p-6 space-y-5">
      <h3 className="text-sm font-semibold text-text-primary">Imagens do produto</h3>

      {/* ── Foto principal ── */}
      <div className="space-y-2">
        <label className="label-base">Foto principal</label>
        <input
          ref={primaryInputRef}
          type="file"
          accept={ACCEPTED_MIME}
          className="hidden"
          onChange={handlePrimaryFileChange}
        />

        <div className="flex items-center gap-4">
          <div className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-overlay">
            {primary ? (
              <Image src={primary.url} alt="Foto principal" fill sizes="96px" className="object-cover" />
            ) : (
              <ImageOff className="h-6 w-6 text-text-muted" />
            )}
          </div>

          {canManage && (
            <div className="flex flex-col items-start gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={uploadingPrimary}
                onClick={() => primaryInputRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4 mr-1" />
                {primary ? 'Trocar foto principal' : 'Enviar foto principal'}
              </Button>
              {primary && (
                <Button type="button" variant="danger" size="sm" onClick={() => handleRemove(primary)}>
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Remover
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Galeria ── */}
      <div className="space-y-2">
        <label className="label-base">Galeria</label>
        <input
          ref={galleryInputRef}
          type="file"
          accept={ACCEPTED_MIME}
          className="hidden"
          onChange={handleGalleryFileChange}
        />

        <div className="flex flex-wrap items-center gap-3">
          {gallery.map((item) => (
            <div
              key={item.usage_id}
              className="group relative h-20 w-20 overflow-hidden rounded-lg border border-border"
            >
              <Image src={item.url} alt="Imagem da galeria" fill sizes="80px" className="object-cover" />
              {canManage && (
                <button
                  type="button"
                  onClick={() => handleRemove(item)}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4 text-white" />
                </button>
              )}
            </div>
          ))}

          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={uploadingGallery}
              onClick={() => galleryInputRef.current?.click()}
            >
              <ImagePlus className="h-4 w-4 mr-1" />
              Adicionar
            </Button>
          )}
        </div>
      </div>

      {!canManage && (
        <p className="text-xs text-text-muted">Apenas gerentes podem alterar imagens.</p>
      )}
    </div>
  )
}
