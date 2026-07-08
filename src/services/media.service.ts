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
import type { Database, MediaVisibility, MediaUsageEntityType, MediaUsageRole } from '@/types/database.types'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type Media = Database['public']['Tables']['media']['Row']
export type MediaUsage = Database['public']['Tables']['media_usages']['Row']

export interface MediaUploadInput {
  buffer: Buffer
  mimeType: string
  fileName: string
  visibility: MediaVisibility
  altText?: string | null
}

export interface MediaUsageInput {
  mediaId: number
  entityType: MediaUsageEntityType
  entityId: string
  role: MediaUsageRole
  position?: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

function uniqueViolation(error: { code: string; message: string }): { message: string; status: number } {
  if (error.code === '23505') {
    if (error.message.includes('uq_media_usages_singular_role')) {
      return {
        message: 'Esta entidade já possui uma mídia com este role (primary/logo/banner/avatar). Desvincule a atual antes de criar outra.',
        status: 409,
      }
    }
    return { message: 'Já existe um vínculo de mídia com este entity_type/entity_id/role/position.', status: 409 }
  }
  return { message: error.message, status: 500 }
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

/** TTL de signed URL para mídia privada — ver docs/media-hub-storage.md. */
const PRIVATE_URL_TTL_SECONDS = 300

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

// ─── Leitura por public_id ─────────────────────────────────────────────────────

/**
 * Busca uma mídia pelo identificador público, escopada à empresa do
 * usuário. Retorna `null` se não existir ou pertencer a outra empresa —
 * as duas situações são indistinguíveis de propósito (evita vazar a
 * existência de um recurso de outra empresa).
 */
export async function getMediaByPublicId(publicId: string, companyId: number): Promise<Media | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('media')
    .select('*')
    .eq('public_id', publicId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: Media | null }
  return data
}

/**
 * Resolve uma mídia para uma URL utilizável:
 *   - `external_url` presente → retorna direto, já é uma URL completa
 *   - `visibility='public'` → URL pública estável (sem expiração)
 *   - `visibility='private'` → signed URL de curta duração
 */
export async function resolveMediaUrl(
  media: Media,
): Promise<ServiceOutcome<{ url: string; expiresAt: string | null }>> {
  if (media.external_url) {
    return success({ url: media.external_url, expiresAt: null })
  }

  if (!media.storage_key) {
    return failure('Mídia sem storage_key nem external_url — dado inconsistente.', 500)
  }

  const admin = createAdminClient()
  const bucket = bucketForVisibility(media.visibility)

  if (media.visibility === 'public') {
    const { data } = admin.storage.from(bucket).getPublicUrl(media.storage_key)
    return success({ url: data.publicUrl, expiresAt: null })
  }

  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(media.storage_key, PRIVATE_URL_TTL_SECONDS)

  if (error || !data) {
    return failure(`Falha ao gerar URL assinada: ${error?.message ?? 'objeto não encontrado no Storage'}`, 502)
  }

  const expiresAt = new Date(Date.now() + PRIVATE_URL_TTL_SECONDS * 1000).toISOString()
  return success({ url: data.signedUrl, expiresAt })
}

// ─── Vínculo de mídia com entidade (media_usages) ──────────────────────────────
// O CHECK do banco aceita 8 roles — o subconjunto realmente permitido por
// entity_type é governança de app, não de schema (mesmo espírito de
// entity_type em si: banco é o teto amplo, service é o subconjunto contextual).

const ALLOWED_ROLES_BY_ENTITY: Record<MediaUsageEntityType, MediaUsageRole[]> = {
  product: ['primary', 'gallery'],
  product_variation: ['primary', 'gallery'],
  shipment: ['proof'],
}

/**
 * Confirma que a entidade (product/product_variation/shipment) pertence à
 * empresa do usuário. product tem company_id próprio; product_variation e
 * shipment não têm — checam via join (mesmo padrão de categoryBelongsToCompany
 * em category-attributes.service.ts). Fail-closed: entity_type desconhecido
 * ou entity_id não numérico sempre retornam false.
 */
export async function entityBelongsToCompany(
  entityType: MediaUsageEntityType,
  entityId: string,
  companyId: number,
): Promise<boolean> {
  const numericId = Number(entityId)
  if (!Number.isFinite(numericId) || numericId <= 0) return false

  const admin = createAdminClient()

  switch (entityType) {
    case 'product': {
      const { data } = await admin
        .from('products')
        .select('id')
        .eq('id', numericId)
        .eq('company_id', companyId)
        .maybeSingle() as unknown as { data: { id: number } | null }
      return !!data
    }
    case 'product_variation': {
      const { data } = await admin
        .from('product_variations')
        .select('id, products!inner(company_id)')
        .eq('id', numericId)
        .eq('products.company_id', companyId)
        .maybeSingle() as unknown as { data: { id: number } | null }
      return !!data
    }
    case 'shipment': {
      const { data } = await admin
        .from('shipments')
        .select('id, sales!inner(company_id)')
        .eq('id', numericId)
        .eq('sales.company_id', companyId)
        .maybeSingle() as unknown as { data: { id: number } | null }
      return !!data
    }
    default:
      return false
  }
}

/**
 * Cria o vínculo media↔entidade. Chamado só depois de confirmar (na rota):
 * mídia existe/pertence à empresa, mídia está ativa, entidade pertence à
 * empresa. `position`, se omitido, é auto-calculado como o próximo da fila
 * para (entity_type, entity_id, role) — sob concorrência rara no mesmo slot,
 * a constraint UNIQUE do banco protege (vira 409, nunca corrupção).
 */
export async function createMediaUsage(
  input: MediaUsageInput,
  companyId: number,
  createdBy: string,
): Promise<ServiceOutcome<MediaUsage>> {
  if (!ALLOWED_ROLES_BY_ENTITY[input.entityType].includes(input.role)) {
    return failure(`Role "${input.role}" não é permitido para entity_type "${input.entityType}".`, 422)
  }

  const admin = createAdminClient()

  let position = input.position
  if (position === undefined) {
    const { data: lastUsage } = await admin
      .from('media_usages')
      .select('position')
      .eq('entity_type', input.entityType)
      .eq('entity_id', input.entityId)
      .eq('role', input.role)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle() as unknown as { data: { position: number } | null }
    position = lastUsage ? lastUsage.position + 1 : 0
  }

  const { data, error } = await admin
    .from('media_usages')
    .insert({
      media_id: input.mediaId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      role: input.role,
      position,
      company_id: companyId,
      created_by: createdBy,
    } as any)
    .select('*')
    .single() as unknown as { data: MediaUsage | null; error: { code: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }

  return success(data!)
}

/**
 * Busca um vínculo pelo id, escopado à empresa do usuário. Retorna `null`
 * se não existir ou pertencer a outra empresa (mesmo anti-oráculo de
 * getMediaByPublicId).
 */
export async function getMediaUsageById(usageId: number, companyId: number): Promise<MediaUsage | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('media_usages')
    .select('*')
    .eq('id', usageId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: MediaUsage | null }
  return data
}

/**
 * Remove fisicamente o vínculo (media_usages é só a referência, não o
 * arquivo) — nunca toca `media` nem o objeto no Storage.
 */
export async function deleteMediaUsage(usageId: number, companyId: number): Promise<ServiceOutcome> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('media_usages')
    .delete()
    .eq('id', usageId)
    .eq('company_id', companyId) as { error: { message: string } | null }

  if (error) return failure(error.message)

  return success(undefined)
}

// ─── Listagem de mídia por entidade ────────────────────────────────────────────

export interface ResolvedMediaUsage {
  usage_id: number
  public_id: string
  role: MediaUsageRole
  position: number
  mime_type: string
  extension: string | null
  file_size: number
  visibility: MediaVisibility
  url: string
  url_expires_at: string | null
  alt_text: string | null
  active: boolean
  created_at: string
}

/**
 * Lista as mídias vinculadas a uma entidade, já resolvidas para URL
 * utilizável. Ordena por role, position, created_at (ordem alfabética de
 * role — não há ordenação semântica tipo "primary primeiro").
 * Item cuja URL não resolve (ex: objeto sumiu do bucket privado) é
 * omitido da lista em vez de derrubar a listagem inteira.
 */
export async function listMediaByEntity(
  entityType: MediaUsageEntityType,
  entityId: string,
  companyId: number,
): Promise<ServiceOutcome<ResolvedMediaUsage[]>> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('media_usages')
    .select('id, role, position, media:media_id (*)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('company_id', companyId)
    .order('role', { ascending: true })
    .order('position', { ascending: true })
    .order('created_at', { ascending: true }) as unknown as {
      data: Array<{ id: number; role: MediaUsageRole; position: number; media: Media }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)

  const items: ResolvedMediaUsage[] = []
  for (const row of data ?? []) {
    const resolved = await resolveMediaUrl(row.media)
    if (!resolved.ok) continue

    items.push({
      usage_id: row.id,
      public_id: row.media.public_id,
      role: row.role,
      position: row.position,
      mime_type: row.media.mime_type,
      extension: row.media.extension,
      file_size: row.media.file_size,
      visibility: row.media.visibility,
      url: resolved.data.url,
      url_expires_at: resolved.data.expiresAt,
      alt_text: row.media.alt_text,
      active: row.media.active,
      created_at: row.media.created_at,
    })
  }

  return success(items)
}

// ─── Listagem em lote (evita N+1 em telas de listagem) ─────────────────────────

export interface EntityPrimaryMedia {
  entity_id: string
  url: string
}

/**
 * Busca a mídia `role='primary'` de várias entidades numa única query —
 * usado por telas de listagem (evita 1 query por linha). Retorna só
 * `entity_id`/`url`: nunca `media.id` nem `storage_key`.
 */
export async function listPrimaryMediaByEntities(
  entityType: MediaUsageEntityType,
  entityIds: string[],
  companyId: number,
): Promise<ServiceOutcome<EntityPrimaryMedia[]>> {
  if (entityIds.length === 0) return success([])

  const admin = createAdminClient()

  const { data, error } = await admin
    .from('media_usages')
    .select('entity_id, media:media_id (*)')
    .eq('entity_type', entityType)
    .in('entity_id', entityIds)
    .eq('role', 'primary')
    .eq('company_id', companyId) as unknown as {
      data: Array<{ entity_id: string; media: Media }> | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)

  const items: EntityPrimaryMedia[] = []
  for (const row of data ?? []) {
    const resolved = await resolveMediaUrl(row.media)
    if (!resolved.ok) continue
    items.push({ entity_id: row.entity_id, url: resolved.data.url })
  }

  return success(items)
}

// ─── Troca atômica de primary ───────────────────────────────────────────────

export interface SetPrimaryMediaResult {
  usage_id: number
  media_id: number
  entity_type: MediaUsageEntityType
  entity_id: string
  position: number
  created_at: string
  previous_usage_id: number | null
  previous_media_id: number | null
}

/**
 * Troca a mídia `primary` de uma entidade numa única transação (RPC
 * rpc_set_primary_media) — remove o vínculo antigo e insere o novo sem
 * deixar a entidade sem primary nenhuma em nenhum momento observável.
 *
 * Posse da entidade é confirmada aqui via entityBelongsToCompany() antes
 * de chamar o RPC — o RPC só valida posse/estado da mídia (company_id,
 * active), não da entidade polimórfica.
 */
export async function setPrimaryMedia(
  mediaId: number,
  entityType: MediaUsageEntityType,
  entityId: string,
  companyId: number,
  userId: string,
): Promise<ServiceOutcome<SetPrimaryMediaResult>> {
  const belongs = await entityBelongsToCompany(entityType, entityId, companyId)
  if (!belongs) return failure('Entidade não encontrada.', 404)

  const admin = createAdminClient()

  const { data, error } = await (admin as any).rpc('rpc_set_primary_media', {
    p_user_id: userId,
    p_media_id: mediaId,
    p_entity_type: entityType,
    p_entity_id: entityId,
  }) as unknown as { data: SetPrimaryMediaResult | null; error: { code: string; message: string } | null }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }

  return success(data!)
}
