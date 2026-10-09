import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from '@/services/wholesale/fakeSupabase.testutil'
import { buildSupabaseImagePatterns } from '../../config/supabase-image-patterns'
import {
  createMediaFromUpload,
  listMediaByEntities,
  listMediaByEntity,
  listPrimaryMediaByEntities,
  resolveMediaUrl,
  type Media,
} from './media.service'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const require_ = createRequire(import.meta.url)
const { hasRemoteMatch } = require_('next/dist/shared/lib/match-remote-pattern') as {
  hasRemoteMatch: (d: string[], p: any[], u: URL) => boolean
}

const SUPABASE_URL = 'https://supabase.santtorini.qarvon.com'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

interface World {
  tables: FakeTables
  buckets: Record<string, Map<string, Buffer>>
  failInsert: boolean
  failRemove: boolean
  failUpload: boolean
}

/** Supabase em memória: Storage (por bucket) + tabela media com insert + leituras via fake do catálogo. */
function makeWorld(): { world: World; admin: any } {
  const world: World = {
    tables: { media: [], media_usages: [] },
    buckets: { 'media-public': new Map(), 'media-private': new Map() },
    failInsert: false,
    failRemove: false,
    failUpload: false,
  }
  const base = createFakeAdmin(world.tables)
  let nextId = 1
  const storage = {
    from: (bucket: string) => ({
      upload: async (key: string, buf: Buffer) => {
        if (world.failUpload) return { error: { message: 'storage down' } }
        world.buckets[bucket].set(key, buf)
        return { error: null }
      },
      remove: async (keys: string[]) => {
        if (world.failRemove) return { error: { message: 'remove denied' } }
        keys.forEach((k) => world.buckets[bucket].delete(k))
        return { error: null }
      },
      getPublicUrl: (key: string) => ({ data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}` } }),
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${key}?token=T` }, error: null }),
    }),
  }
  const admin = {
    ...base,
    storage,
    from: (table: string) => {
      if (table !== 'media') return base.from(table)
      let row: any
      const q: any = {
        insert: (r: any) => { row = r; return q },
        select: () => q,
        single: async () => {
          if (world.failInsert) return { data: null, error: { code: 'XX', message: 'insert failed' } }
          const saved = { id: nextId++, active: true, status: 'ready', created_at: new Date().toISOString(), external_url: null, ...row }
          world.tables.media.push(saved)
          return { data: saved, error: null }
        },
      }
      return q
    },
  }
  return { world, admin }
}

let world: World
let errorSpy: { mock: { calls: unknown[][] }; mockRestore: () => void }

beforeEach(() => {
  const made = makeWorld()
  world = made.world
  vi.mocked(createAdminClient).mockReturnValue(made.admin)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errorSpy.mockRestore())

const logs = (): Array<Record<string, any>> => errorSpy.mock.calls.map((c) => JSON.parse(String(c[0])))

function link(mediaId: number, companyId: number, entityId: string, role = 'primary', position = 0) {
  world.tables.media_usages.push({ id: world.tables.media_usages.length + 1, media_id: mediaId, company_id: companyId, entity_type: 'product', entity_id: entityId, role, position })
}

describe('upload → Storage → banco → vínculo → listagem → renderização', () => {
  it('fluxo completo: arquivo no bucket, storage_key persistido, URL aceita pelo next/image, persiste entre leituras', async () => {
    const up = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/jpeg', fileName: 'foto.jpg', visibility: 'public' }, 7, 'user-1')
    expect(up.ok).toBe(true)
    const media = up.data as Media

    // Storage: o objeto REALMENTE chegou ao bucket certo, sob o path company/uuid.ext
    expect(media.storage_key).toMatch(/^7\/[0-9a-f-]{36}\.jpg$/)
    expect(world.buckets['media-public'].get(media.storage_key!)).toEqual(JPEG)
    expect(world.buckets['media-private'].size).toBe(0)
    // Banco: registro persistido com storage_key e dono correto
    expect(world.tables.media).toHaveLength(1)
    expect(world.tables.media[0]).toMatchObject({ company_id: 7, storage_key: media.storage_key, visibility: 'public' })

    link(media.id, 7, '42')

    // Duas leituras ("atualizar a página") devolvem a mesma URL estável
    const first = await listMediaByEntities('product', ['42'], 7)
    const second = await listMediaByEntities('product', ['42'], 7)
    expect(first.ok && second.ok).toBe(true)
    const url = first.data![0].url
    expect(second.data![0].url).toBe(url)
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/public/media-public/${media.storage_key}`)

    // Renderização: a URL entregue ao frontend é aceita pelo otimizador do Next
    const patterns = buildSupabaseImagePatterns(SUPABASE_URL, { production: true })
    expect(hasRemoteMatch([], patterns, new URL(url))).toBe(true)
    // ...e o objeto existe no Storage sob a mesma chave
    expect(world.buckets['media-public'].has(url.split('/media-public/')[1])).toBe(true)
  })

  it('rejeita MIME fora da allowlist e arquivo vazio sem tocar no Storage', async () => {
    const svg = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/svg+xml', fileName: 'x.svg', visibility: 'public' }, 1, null)
    const empty = await createMediaFromUpload({ buffer: Buffer.alloc(0), mimeType: 'image/png', fileName: 'x.png', visibility: 'public' }, 1, null)
    expect(svg.ok).toBe(false)
    expect(empty.ok).toBe(false)
    expect(world.buckets['media-public'].size).toBe(0)
  })

  it('falha do Storage não cria registro e é logada', async () => {
    world.failUpload = true
    const r = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/jpeg', fileName: 'a.jpg', visibility: 'public' }, 1, null)
    expect(r.ok).toBe(false)
    expect(world.tables.media).toHaveLength(0)
    expect(logs().map((l) => l.event)).toContain('media.upload_storage_failed')
  })

  it('falha no INSERT remove o objeto recém-gravado (sem upload órfão)', async () => {
    world.failInsert = true
    const r = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/jpeg', fileName: 'a.jpg', visibility: 'public' }, 1, null)
    expect(r.ok).toBe(false)
    expect(world.buckets['media-public'].size).toBe(0)
    expect(logs().map((l) => l.event)).toEqual(['media.upload_db_failed', 'media.upload_orphan_cleaned'])
  })

  it('se a limpeza também falhar, registra o órfão para varredura', async () => {
    world.failInsert = true
    world.failRemove = true
    await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/jpeg', fileName: 'a.jpg', visibility: 'public' }, 1, null)
    expect(world.buckets['media-public'].size).toBe(1)
    expect(logs().map((l) => l.event)).toContain('media.upload_orphan_cleanup_failed')
  })
})

describe('erros silenciosos em resolveMediaUrl / listagens', () => {
  it('mídia sem storage_key nem external_url falha explicitamente', async () => {
    const r = await resolveMediaUrl({ visibility: 'public', storage_key: null, external_url: null } as Media)
    expect(r.ok).toBe(false)
  })

  it('listagens omitem o item quebrado MAS agora registram log estruturado (sem URL nem chave)', async () => {
    world.tables.media.push(
      { id: 1, public_id: 'good', company_id: 3, visibility: 'public', storage_key: '3/good.jpg', external_url: null, active: true },
      { id: 2, public_id: 'broken', company_id: 3, visibility: 'public', storage_key: null, external_url: null, active: true },
    )
    link(1, 3, '10', 'primary')
    link(2, 3, '10', 'gallery', 1)

    const byEntity = await listMediaByEntity('product', '10', 3)
    const batch = await listMediaByEntities('product', ['10'], 3)
    const primary = await listPrimaryMediaByEntities('product', ['10'], 3)
    expect(byEntity.data).toHaveLength(1)
    expect(batch.data).toHaveLength(1)
    expect(primary.data).toHaveLength(1)

    const events = logs()
    expect(events).toHaveLength(2) // entity + batch; a primary não inclui a galeria
    for (const e of events) {
      expect(e).toMatchObject({ event: 'media.url_resolve_failed', mediaPublicId: 'broken', companyId: 3, bucket: 'media-public', entityType: 'product', entityId: '10' })
      expect(JSON.stringify(e)).not.toMatch(/https?:|token|"storage_key"/i)
    }
  })

  it('primary quebrada também é logada', async () => {
    world.tables.media.push({ id: 5, public_id: 'p', company_id: 3, visibility: 'public', storage_key: null, external_url: null, active: true })
    link(5, 3, '11', 'primary')
    const r = await listPrimaryMediaByEntities('product', ['11'], 3)
    expect(r.data).toEqual([])
    expect(logs()[0]).toMatchObject({ event: 'media.url_resolve_failed', entityId: '11' })
  })
})

describe('isolamento entre empresas', () => {
  it('empresa B não enxerga mídia/vínculo da empresa A', async () => {
    const a = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/jpeg', fileName: 'a.jpg', visibility: 'public' }, 1, null)
    link((a.data as Media).id, 1, '99')

    const asA = await listMediaByEntities('product', ['99'], 1)
    const asB = await listMediaByEntities('product', ['99'], 2)
    expect(asA.data).toHaveLength(1)
    expect(asB.data).toEqual([])
    expect((await listMediaByEntity('product', '99', 2)).data).toEqual([])
    expect((await listPrimaryMediaByEntities('product', ['99'], 2)).data).toEqual([])
  })

  it('path no Storage sempre carrega o company_id da sessão', async () => {
    const a = await createMediaFromUpload({ buffer: JPEG, mimeType: 'image/png', fileName: '../../1/evil.png', visibility: 'public' }, 5, null)
    expect((a.data as Media).storage_key!.startsWith('5/')).toBe(true)
    expect((a.data as Media).storage_key).not.toContain('..')
  })
})
