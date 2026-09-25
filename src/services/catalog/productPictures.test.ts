import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNuvemshopFakeDb, mediaRow, usageRow, publicUrl, type NsFakeTables, type NsFakeDbOptions } from '@/services/nuvemshop/nuvemshop.testutil'
import {
  loadEntityPictures,
  loadProductPicturesProductFirst,
  loadVariationListingPictureUrls,
  validatePublicPictures,
  type OrderedProductPicture,
} from './productPictures'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

let tables: NsFakeTables
let dbOptions: NsFakeDbOptions

beforeEach(() => {
  dbOptions = {}
  tables = { media: [], media_usages: [] }
  ;(createAdminClient as any).mockImplementation(() => createNuvemshopFakeDb(tables, dbOptions))
})

const add = (media: ReturnType<typeof mediaRow>, usage: ReturnType<typeof usageRow>) => {
  tables.media.push(media)
  tables.media_usages.push(usage)
}

describe('loadEntityPictures', () => {
  it('foto principal primeiro, galeria pela position', async () => {
    add(mediaRow(1, 1, 'g2', 'jpg'), usageRow(1, 1, 1, 'product', '10', 'gallery', 2))
    add(mediaRow(2, 1, 'main', 'jpg'), usageRow(2, 2, 1, 'product', '10', 'primary', 0))
    add(mediaRow(3, 1, 'g1', 'png'), usageRow(3, 3, 1, 'product', '10', 'gallery', 1))
    const r = await loadEntityPictures(1, 'product', ['10'])
    expect(r.ok && r.data.get('10')!.map((p) => p.url)).toEqual([publicUrl('1/main.jpg'), publicUrl('1/g1.png'), publicUrl('1/g2.jpg')])
  })

  it('exclui mídia privada, inativa e de outra empresa (vínculo ou mídia)', async () => {
    add(mediaRow(1, 1, 'ok', 'jpg'), usageRow(1, 1, 1, 'product', '10', 'primary', 0))
    add(mediaRow(2, 1, 'priv', 'jpg', { visibility: 'private' }), usageRow(2, 2, 1, 'product', '10', 'gallery', 1))
    add(mediaRow(3, 1, 'off', 'jpg', { active: false }), usageRow(3, 3, 1, 'product', '10', 'gallery', 2))
    add(mediaRow(4, 2, 'outra', 'jpg'), usageRow(4, 4, 1, 'product', '10', 'gallery', 3)) // vínculo da empresa 1 → mídia da 2
    add(mediaRow(5, 1, 'x', 'jpg'), usageRow(5, 5, 2, 'product', '10', 'gallery', 4))       // vínculo de outra empresa
    const r = await loadEntityPictures(1, 'product', ['10'])
    expect(r.ok && r.data.get('10')!.map((p) => p.url)).toEqual([publicUrl('1/ok.jpg')])
  })

  it('produto sem imagem → lista vazia; erro de banco → ok:false', async () => {
    const empty = await loadEntityPictures(1, 'product', ['99'])
    expect(empty.ok && empty.data.size).toBe(0)
    dbOptions.failSelectTables = ['media_usages']
    expect((await loadEntityPictures(1, 'product', ['10'])).ok).toBe(false)
  })
})

describe('loadProductPicturesProductFirst (Nuvemshop)', () => {
  it('ordem: principal do produto, galeria do produto, principais das variações, galerias das variações; posição sequencial', async () => {
    add(mediaRow(1, 1, 'p-gal', 'jpg'), usageRow(1, 1, 1, 'product', '10', 'gallery', 0))
    add(mediaRow(2, 1, 'p-main', 'jpg'), usageRow(2, 2, 1, 'product', '10', 'primary', 0))
    add(mediaRow(3, 1, 'v102-gal', 'jpg'), usageRow(3, 3, 1, 'product_variation', '102', 'gallery', 0))
    add(mediaRow(4, 1, 'v101-main', 'jpg'), usageRow(4, 4, 1, 'product_variation', '101', 'primary', 0))
    add(mediaRow(5, 1, 'v102-main', 'jpg'), usageRow(5, 5, 1, 'product_variation', '102', 'primary', 0))
    const r = await loadProductPicturesProductFirst(1, 10, [101, 102])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.map((p) => [p.position, p.url])).toEqual([
      [1, publicUrl('1/p-main.jpg')],
      [2, publicUrl('1/p-gal.jpg')],
      [3, publicUrl('1/v101-main.jpg')],
      [4, publicUrl('1/v102-main.jpg')],
      [5, publicUrl('1/v102-gal.jpg')],
    ])
  })

  it('mídia reutilizada (produto + variação) e URL repetida aparecem uma vez só', async () => {
    tables.media.push(mediaRow(1, 1, 'main', 'jpg'), mediaRow(2, 1, 'main', 'jpg', { public_id: 'outra-midia-mesma-url' }))
    tables.media_usages.push(
      usageRow(1, 1, 1, 'product', '10', 'primary', 0),
      usageRow(2, 1, 1, 'product_variation', '101', 'primary', 0), // mesma mídia
      usageRow(3, 2, 1, 'product_variation', '102', 'primary', 0), // mesma URL
    )
    const r = await loadProductPicturesProductFirst(1, 10, [101, 102])
    expect(r.ok && r.data.map((p) => p.position)).toEqual([1])
  })

  it('falha ao ler variações propaga erro (não vira "sem imagem")', async () => {
    dbOptions.failSelectTables = ['media_usages']
    expect((await loadProductPicturesProductFirst(1, 10, [101])).ok).toBe(false)
  })
})

describe('loadVariationListingPictureUrls (Mercado Livre — comportamento preservado)', () => {
  it('variação primeiro, depois produto; principal antes da galeria em cada um', async () => {
    add(mediaRow(1, 1, 'p-main', 'jpg'), usageRow(1, 1, 1, 'product', '10', 'primary', 0))
    add(mediaRow(2, 1, 'v-gal', 'jpg'), usageRow(2, 2, 1, 'product_variation', '101', 'gallery', 0))
    add(mediaRow(3, 1, 'v-main', 'jpg'), usageRow(3, 3, 1, 'product_variation', '101', 'primary', 0))
    const urls = await loadVariationListingPictureUrls(1, 10, 101, async () => 'https://legado/foto.jpg')
    expect(urls).toEqual([publicUrl('1/v-main.jpg'), publicUrl('1/v-gal.jpg'), publicUrl('1/p-main.jpg')])
  })

  it('photo_url legado só quando o Media Hub não tem nada', async () => {
    expect(await loadVariationListingPictureUrls(1, 10, 101, async () => 'https://legado/foto.jpg')).toEqual(['https://legado/foto.jpg'])
    expect(await loadVariationListingPictureUrls(1, 10, 101, async () => null)).toEqual([])
  })

  it('URL repetida entre variação e produto aparece uma vez', async () => {
    tables.media.push(mediaRow(1, 1, 'same', 'jpg'))
    tables.media_usages.push(usageRow(1, 1, 1, 'product_variation', '101', 'primary', 0), usageRow(2, 1, 1, 'product', '10', 'primary', 0))
    expect(await loadVariationListingPictureUrls(1, 10, 101)).toEqual([publicUrl('1/same.jpg')])
  })
})

describe('validatePublicPictures', () => {
  const pic = (url: string, over: Partial<OrderedProductPicture> = {}): OrderedProductPicture => ({
    publicId: url, url, role: 'gallery', entityType: 'product', entityId: '10', usagePosition: 0,
    mimeType: 'image/jpeg', extension: 'jpg', status: 'ready', position: 1, ...over,
  })

  it('recusa URL assinada, formato não aceito e mídia não pronta; re-sequencia posições', () => {
    const r = validatePublicPictures([
      pic('https://s/sign.jpg?token=abc'),
      pic('https://s/a.jpg'),
      pic('https://s/b.bmp', { extension: 'bmp' }),
      pic('https://s/c.png', { extension: 'png', status: 'processing' }),
      pic('https://s/d.webp', { extension: 'webp' }),
    ], ['jpg', 'jpeg', 'png', 'gif', 'webp'])
    expect(r.valid.map((p) => [p.position, p.url])).toEqual([[1, 'https://s/a.jpg'], [2, 'https://s/d.webp']])
    expect(r.invalid.map((i) => i.reason)).toEqual([
      'URL assinada (expira) não pode ser usada', 'formato .bmp não aceito', 'mídia não está pronta (processing)',
    ])
  })
})
