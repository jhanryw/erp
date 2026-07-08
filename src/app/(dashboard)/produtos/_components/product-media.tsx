'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import Image from 'next/image'
import { ImagePlus, ImageOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUserContext } from '@/components/layout/user-context'
import { hasMinRole } from '@/types/roles'

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
  // Só esconde os botões de ação — é UX, não autorização. A permissão real
  // continua sendo o backend (requireRole/hasMinRole em POST/DELETE de
  // usages); se alguém forçar a chamada via DevTools, o 403 do servidor
  // continua acontecendo normalmente.
  const { userRole } = useUserContext()
  const canManage = hasMinRole(userRole, 'gerente')

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

  async function uploadAndLink(file: File, role: 'primary' | 'gallery') {
    const setUploading = role === 'primary' ? setUploadingPrimary : setUploadingGallery
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

      const linkRes = await fetch(`/api/media/${uploadJson.media.public_id}/usages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'product',
          entity_id: String(productId),
          role,
        }),
      })
      const linkJson = await linkRes.json()

      if (!linkRes.ok) {
        toast.error('Imagem enviada, mas não foi possível vincular ao produto', {
          description: linkJson.error,
        })
        return
      }

      toast.success(role === 'primary' ? 'Foto principal atualizada!' : 'Imagem adicionada à galeria!')
      await loadMedia()
    } catch {
      toast.error('Erro de rede ao enviar imagem')
    } finally {
      setUploading(false)
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>, role: 'primary' | 'gallery') {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    uploadAndLink(file, role)
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
          onChange={(e) => handleFileChange(e, 'primary')}
        />

        {primary ? (
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 overflow-hidden rounded-lg border border-border">
              <Image src={primary.url} alt="Foto principal" fill sizes="96px" className="object-cover" />
            </div>
            {canManage && (
              <Button type="button" variant="danger" size="sm" onClick={() => handleRemove(primary)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Remover
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-border text-text-muted">
              <ImageOff className="h-6 w-6" />
            </div>
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={uploadingPrimary}
                onClick={() => primaryInputRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4 mr-1" />
                Enviar foto principal
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Galeria ── */}
      <div className="space-y-2">
        <label className="label-base">Galeria</label>
        <input
          ref={galleryInputRef}
          type="file"
          accept={ACCEPTED_MIME}
          className="hidden"
          onChange={(e) => handleFileChange(e, 'gallery')}
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
