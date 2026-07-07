/**
 * Service do Media Hub — lógica de negócio desacoplada de HTTP.
 *
 * Escopo desta entrega: apenas upload real (Storage + insert em `media`).
 * Nenhuma função de `media_usages`, thumbnails, OCR, IA ou vínculo com
 * entidade de negócio existe ainda — ver docs/media-hub-storage.md e a
 * auditoria da API para o que vem depois.
 *
 * Regras que este arquivo aplica (não repetir na rota):
 *   - bucket nunca vem do cliente — é sempre derivado de `visibility`
 *   - company_id nunca vem do cliente — é sempre parâmetro explícito
 *   - created_source é sempre 'upload' — não é aceito como input
 *   - extension é sempre derivada do mime_type — nunca do nome do arquivo
 */

import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Database, MediaVisibility } from '@/types/database.types'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type Media = Database['public']['Tables']['media']['Row']

export interface MediaUploadInput {
  buffer: Buffer
  mimeType: string
  fileName: string
  visibility: MediaVisibility
  altText?: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

/** Remove caracteres de controle e limita tamanho — nunca usado para montar path real. */
function sanitizeFilename(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  return fileName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255)
}

// ─── Regras de bucket por visibilidade ────────────────────────────────────────
// Buckets já criados manualmente no painel do Supabase Storage — ver
// docs/media-hub-storage.md para a configuração completa aprovada.

interface BucketRule {
  bucket: string
  allowedMimeTypes: string[]
  maxFileSize: number
}

const BUCKET_RULES: Record<MediaVisibility, BucketRule> = {
  public: {
    bucket: 'media-public',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxFileSize: 5 * 1024 * 1024,
  },
  private: {
    bucket: 'media-private',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxFileSize: 15 * 1024 * 1024,
  },
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/** Nunca aceitar bucket vindo do cliente — só esta função decide. */
export function bucketForVisibility(visibility: MediaVisibility): string {
  return BUCKET_RULES[visibility].bucket
}

/** Extensão sempre derivada do mime_type, nunca do nome do arquivo do cliente. */
export function extensionForMime(mimeType: string): string | null {
  return MIME_EXTENSION_MAP[mimeType] ?? null
}

// ─── Operação de upload ────────────────────────────────────────────────────────

/**
 * Sobe o arquivo para o Storage e insere o registro em `media`.
 * Upload primeiro, banco depois: se o insert falhar após o upload ter
 * sucesso, o objeto fica órfão no bucket — sem rollback automático nesta
 * entrega (dívida técnica conhecida, documentada na auditoria).
 */
export async function createMediaFromUpload(
  input: MediaUploadInput,
  companyId: number,
  uploadedBy: string,
): Promise<ServiceOutcome<Media>> {
  const rules = BUCKET_RULES[input.visibility]

  if (input.buffer.byteLength === 0) {
    return failure('Arquivo vazio.', 422)
  }

  if (!rules.allowedMimeTypes.includes(input.mimeType)) {
    return failure(`Tipo de arquivo não permitido para visibilidade "${input.visibility}".`, 422)
  }

  if (input.buffer.byteLength > rules.maxFileSize) {
    const maxMb = rules.maxFileSize / (1024 * 1024)
    return failure(`Arquivo excede o tamanho máximo de ${maxMb}MB.`, 422)
  }

  const extension = extensionForMime(input.mimeType)
  if (!extension) {
    return failure('Não foi possível determinar a extensão do arquivo.', 422)
  }

  const publicId = randomUUID()
  const storageKey = `${companyId}/${publicId}.${extension}`

  const admin = createAdminClient()

  const { error: uploadError } = await admin.storage
    .from(rules.bucket)
    .upload(storageKey, input.buffer, { contentType: input.mimeType, upsert: false })

  if (uploadError) {
    return failure(`Falha no upload para o Storage: ${uploadError.message}`, 502)
  }

  const { data, error: insertError } = await admin
    .from('media')
    .insert({
      public_id: publicId,
      company_id: companyId,
      storage_key: storageKey,
      visibility: input.visibility,
      original_filename: sanitizeFilename(input.fileName),
      extension,
      mime_type: input.mimeType,
      file_size: input.buffer.byteLength,
      created_source: 'upload',
      uploaded_by: uploadedBy,
      alt_text: input.altText ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: Media | null; error: { code: string; message: string } | null }

  if (insertError) {
    // Objeto já gravado no Storage (storageKey acima) — órfão temporário,
    // sem rollback automático nesta entrega. Ver docs/media-hub-storage.md.
    return failure(insertError.message, 500)
  }

  return success(data!)
}
