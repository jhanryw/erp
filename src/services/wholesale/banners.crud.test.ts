import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import {
  createWholesaleBanner,
  updateWholesaleBanner,
  deleteWholesaleBanner,
  reorderWholesaleBanners,
  listWholesaleBanners,
  getActiveWholesaleBanners,
  wholesaleBannerContentShape,
} from './banners'
import { z } from 'zod'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
// Resolução de URL: determinística a partir do storage_key (o Storage real é coberto em media.service.test.ts).
vi.mock('@/services/media.service', () => ({
  resolveMediaUrl: vi.fn(async (m: { storage_key: string | null }) =>
    m.storage_key ? { ok: true, data: { url: `https://cdn.test/${m.storage_key}`, expiresAt: null } } : { ok: false, error: 'sem chave', status: 500 }),
}))

const A = 1
const B = 2

let tables: FakeTables
let admin: FakeAdmin

function media(id: number, company: number, extra: Record<string, unknown> = {}) {
  return { id, public_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, company_id: company, visibility: 'public', active: true, storage_key: `${company}/m${id}.jpg`, external_url: null, alt_text: null, ...extra }
}
const pid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`

beforeEach(() => {
  tables = {
    media: [media(1, A), media(2, A), media(3, B), media(4, A, { visibility: 'private' }), media(5, A, { active: false })],
    categories: [{ id: 1, company_id: A, slug: 'calcinhas', name: 'Calcinhas' }, { id: 2, company_id: B, slug: 'blusas', name: 'Blusas' }],
    products: [{ id: 10, company_id: A }, { id: 20, company_id: B }],
    wholesale_site_banners: [],
  }
  admin = createFakeAdmin(tables)
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
})

const NONE = { type: 'none' } as const

describe('CRUD de banners', () => {
  it('cria banner só com imagem (sem textos) → showText padrão, sem mobile', async () => {
    const r = await createWholesaleBanner(A, { mediaPublicId: pid(1), link: NONE })
    expect(r.ok).toBe(true)
    expect(r.ok && r.data).toMatchObject({ imageUrl: 'https://cdn.test/1/m1.jpg', mobileImageUrl: null, title: null, subtitle: null, ctaLabel: null, showText: true, isActive: true, sortOrder: 0 })
  })

  it('cria banner com imagem desktop + mobile + textos + CTA e "somente imagem" (showText=false)', async () => {
    const r = await createWholesaleBanner(A, {
      mediaPublicId: pid(1), mobileMediaPublicId: pid(2),
      title: 'Coleção Verão', subtitle: 'Peças leves', ctaLabel: 'Ver coleção', showText: false,
      link: { type: 'category', categorySlug: 'calcinhas' },
    })
    expect(r.ok && r.data).toMatchObject({
      imageUrl: 'https://cdn.test/1/m1.jpg', mobileImageUrl: 'https://cdn.test/1/m2.jpg',
      title: 'Coleção Verão', subtitle: 'Peças leves', ctaLabel: 'Ver coleção', showText: false,
      link: { type: 'category', categorySlug: 'calcinhas' },
    })
  })

  it('ordem: novos banners entram no fim', async () => {
    await createWholesaleBanner(A, { mediaPublicId: pid(1), link: NONE })
    const second = await createWholesaleBanner(A, { mediaPublicId: pid(2), link: NONE })
    expect(second.ok && second.data.sortOrder).toBe(1)
  })

  it('rejeita mídia de outra empresa, privada ou inativa (desktop e mobile)', async () => {
    for (const bad of [pid(3), pid(4), pid(5), pid(999)]) {
      const r = await createWholesaleBanner(A, { mediaPublicId: bad, link: NONE })
      expect(r).toMatchObject({ ok: false, status: 404 })
      const m = await createWholesaleBanner(A, { mediaPublicId: pid(1), mobileMediaPublicId: bad, link: NONE })
      expect(m).toMatchObject({ ok: false, status: 404 })
    }
    expect(tables.wholesale_site_banners).toHaveLength(0)
  })

  it('rejeita categoria/produto de outra empresa como destino', async () => {
    expect(await createWholesaleBanner(A, { mediaPublicId: pid(1), link: { type: 'category', categorySlug: 'blusas' } })).toMatchObject({ ok: false, status: 422 })
    expect(await createWholesaleBanner(A, { mediaPublicId: pid(1), link: { type: 'product', productId: 20 } })).toMatchObject({ ok: false, status: 422 })
    expect((await createWholesaleBanner(A, { mediaPublicId: pid(1), link: { type: 'product', productId: 10 } })).ok).toBe(true)
  })

  it('atualiza textos, ativa/desativa e troca/remove imagem mobile', async () => {
    const created = await createWholesaleBanner(A, { mediaPublicId: pid(1), link: NONE })
    const id = created.ok ? created.data.id : -1

    const withMobile = await updateWholesaleBanner(A, id, { mobileMediaPublicId: pid(2), title: 'Novo', showText: false, isActive: false })
    expect(withMobile.ok && withMobile.data).toMatchObject({ mobileImageUrl: 'https://cdn.test/1/m2.jpg', title: 'Novo', showText: false, isActive: false })

    const removed = await updateWholesaleBanner(A, id, { mobileMediaPublicId: null })
    expect(removed.ok && removed.data.mobileImageUrl).toBeNull()
  })

  it('PATCH parcial não apaga campos ausentes (chave ausente ≠ limpar)', async () => {
    const created = await createWholesaleBanner(A, { mediaPublicId: pid(1), title: 'Mantém', subtitle: 'Sub', ctaLabel: 'Ir', link: NONE })
    const id = created.ok ? created.data.id : -1

    const parsed = z.object(wholesaleBannerContentShape).parse({ isActive: true })
    const r = await updateWholesaleBanner(A, id, { ...parsed, isActive: false })
    expect(r.ok && r.data).toMatchObject({ title: 'Mantém', subtitle: 'Sub', ctaLabel: 'Ir', isActive: false })

    const cleared = z.object(wholesaleBannerContentShape).parse({ title: '   ' })
    const r2 = await updateWholesaleBanner(A, id, cleared)
    expect(r2.ok && r2.data.title).toBeNull()
  })

  it('validação dos textos: limites e trim', () => {
    const schema = z.object(wholesaleBannerContentShape)
    expect(schema.safeParse({ title: 'x'.repeat(81) }).success).toBe(false)
    expect(schema.safeParse({ subtitle: 'x'.repeat(161) }).success).toBe(false)
    expect(schema.safeParse({ ctaLabel: 'x'.repeat(31) }).success).toBe(false)
    expect(schema.parse({ title: '  Olá  ' }).title).toBe('Olá')
  })

  it('exclui banner', async () => {
    const created = await createWholesaleBanner(A, { mediaPublicId: pid(1), link: NONE })
    const id = created.ok ? created.data.id : -1
    expect(await deleteWholesaleBanner(A, id)).toEqual({ ok: true })
    expect(tables.wholesale_site_banners).toHaveLength(0)
    expect(await deleteWholesaleBanner(A, id)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('isolamento entre empresas', () => {
  it('empresa B não edita, exclui, lista nem reordena banners da A', async () => {
    const created = await createWholesaleBanner(A, { mediaPublicId: pid(1), title: 'Da A', link: NONE })
    const id = created.ok ? created.data.id : -1

    expect(await updateWholesaleBanner(B, id, { title: 'Invadido' })).toMatchObject({ ok: false, status: 404 })
    expect(await deleteWholesaleBanner(B, id)).toMatchObject({ ok: false, status: 404 })
    expect(await listWholesaleBanners(B)).toEqual([])
    expect(await getActiveWholesaleBanners(B)).toEqual([])
    await reorderWholesaleBanners(B, [id])
    expect(tables.wholesale_site_banners[0]).toMatchObject({ title: 'Da A', sort_order: 0 })
  })

  it('B não consegue apontar o banner de A para uma mídia da empresa A', async () => {
    const bBanner = await createWholesaleBanner(B, { mediaPublicId: pid(3), link: NONE })
    const id = bBanner.ok ? bBanner.data.id : -1
    expect(await updateWholesaleBanner(B, id, { mediaPublicId: pid(1) })).toMatchObject({ ok: false, status: 404 })
    expect(await updateWholesaleBanner(B, id, { mobileMediaPublicId: pid(1) })).toMatchObject({ ok: false, status: 404 })
  })
})

describe('vitrine pública', () => {
  it('só banners ativos, em ordem, e descarta o que não resolve imagem', async () => {
    const a = await createWholesaleBanner(A, { mediaPublicId: pid(1), title: 'Primeiro', link: NONE })
    const b = await createWholesaleBanner(A, { mediaPublicId: pid(2), title: 'Segundo', link: NONE })
    const c = await createWholesaleBanner(A, { mediaPublicId: pid(1), title: 'Inativo', link: NONE })
    const d = await createWholesaleBanner(A, { mediaPublicId: pid(1), title: 'Quebrado', link: NONE })
    if (!(a.ok && b.ok && c.ok && d.ok)) throw new Error('setup')
    await updateWholesaleBanner(A, c.data.id, { isActive: false })
    await reorderWholesaleBanners(A, [b.data.id, a.data.id, c.data.id, d.data.id])
    tables.media.push(media(6, A, { storage_key: null }))
    tables.wholesale_site_banners.find((r) => r.id === d.data.id)!.media_id = 6

    const active = await getActiveWholesaleBanners(A)
    expect(active.map((x) => x.title)).toEqual(['Segundo', 'Primeiro'])
  })
})
