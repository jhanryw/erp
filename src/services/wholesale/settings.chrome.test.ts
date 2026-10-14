import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleSiteSettings, updateWholesaleSiteSettings } from './settings'
import { DEFAULT_SITE_CHROME } from './siteChrome'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntity: vi.fn() }))

const A = 1
const B = 2
let tables: FakeTables

/** Admin cujo SELECT em `wholesale_site_settings` falha por coluna inexistente nos níveis em que `missing` aparece. */
function adminMissing(missing: string[], failure = { code: '42703', message: 'column does not exist' }) {
  const real = createFakeAdmin(tables)
  return {
    ...real,
    from: (table: string) => {
      const q = real.from(table)
      if (table !== 'wholesale_site_settings') return q
      const select = q.select.bind(q)
      q.select = (cols: string) => {
        if (missing.some((m) => String(cols).includes(m))) {
          const failing: any = { eq: () => failing, maybeSingle: () => failing, then: (r: any) => r({ data: null, error: failure }) }
          return failing
        }
        return select(cols)
      }
      return q
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  tables = { wholesale_site_settings: [] }
  ;(createAdminClient as any).mockImplementation(() => createFakeAdmin(tables))
})

describe('configuração institucional: persistência e isolamento', () => {
  it('salva, recupera e isola por empresa; WhatsApp do carrinho segue sendo o único número', async () => {
    await updateWholesaleSiteSettings(A, {
      whatsappPhone: '84988887777', announcementIntervalSeconds: 8,
      chrome: { footer: { hours: 'Seg a sex' }, social: { instagramUrl: 'https://instagram.com/a' }, whatsappFloat: { message: 'Oi da A' } },
    })
    await updateWholesaleSiteSettings(B, { chrome: { footer: { hours: 'Da B' } } })

    const a = await getWholesaleSiteSettings(A)
    expect(a.whatsappPhone).toBe('84988887777')
    expect(a.announcementIntervalSeconds).toBe(8)
    expect(a.chrome.footer.hours).toBe('Seg a sex')
    expect(a.chrome.whatsappFloat).toMatchObject({ message: 'Oi da A', enabledDesktop: true })
    expect((await getWholesaleSiteSettings(B)).chrome.footer.hours).toBe('Da B')
    expect(Object.keys(a.chrome.whatsappFloat)).not.toContain('phone')
  })

  it('salvar só campos comerciais não apaga a configuração institucional (e vice-versa)', async () => {
    await updateWholesaleSiteSettings(A, { chrome: { store: { tradeName: 'Santtorini' } } })
    await updateWholesaleSiteSettings(A, { minimumOrderAmount: 450 })
    const s = await getWholesaleSiteSettings(A)
    expect(s.chrome.store.tradeName).toBe('Santtorini')
    expect(s.minimumOrderAmount).toBe(450)
    await updateWholesaleSiteSettings(A, { chrome: { footer: { hours: 'x' } } })
    expect((await getWholesaleSiteSettings(A)).minimumOrderAmount).toBe(450)
  })

  it('sem linha: padrões (rodapé padrão, botão ligado, intervalo 5 s)', async () => {
    const s = await getWholesaleSiteSettings(A)
    expect(s.chrome).toEqual(DEFAULT_SITE_CHROME)
    expect(s.announcementIntervalSeconds).toBe(5)
  })

  it('JSONB corrompido no banco nunca derruba a leitura', async () => {
    tables.wholesale_site_settings.push({ company_id: A, catalog_active: true, minimum_order_amount: 300, show_out_of_stock: false, show_stock_quantity: false, show_search: true, show_categories: true, pixel_enabled: false, site_chrome: 'lixo', announcement_interval_seconds: 999 })
    const s = await getWholesaleSiteSettings(A)
    expect(s.chrome).toEqual(DEFAULT_SITE_CHROME)
    expect(s.announcementIntervalSeconds).toBe(5)
  })
})

describe('fallback seguro quando migrations ainda não existem', () => {
  it('sem as colunas do chrome: lê o nível anterior e usa padrões institucionais', async () => {
    tables.wholesale_site_settings.push({ company_id: A, catalog_active: true, display_name: 'Santtorini', whatsapp_phone: '84988887777', minimum_order_amount: 300, show_out_of_stock: false, show_stock_quantity: false, show_search: true, show_categories: true, pixel_enabled: false, hero_title: 'Olá' })
    ;(createAdminClient as any).mockImplementation(() => adminMissing(['site_chrome']))
    const s = await getWholesaleSiteSettings(A)
    expect(s).toMatchObject({ displayName: 'Santtorini', whatsappPhone: '84988887777' })
    expect(s.texts.heroTitle).toBe('Olá')
    expect(s.chrome).toEqual(DEFAULT_SITE_CHROME)
  })

  it('sem as colunas de texto E de chrome: cai para a base legada, e o catálogo segue no ar', async () => {
    tables.wholesale_site_settings.push({ company_id: A, catalog_active: true, display_name: 'Santtorini', whatsapp_phone: '84988887777', minimum_order_amount: 300, show_out_of_stock: false, show_stock_quantity: false, show_search: true, show_categories: true, pixel_enabled: false })
    ;(createAdminClient as any).mockImplementation(() => adminMissing(['site_chrome', 'hero_title']))
    const s = await getWholesaleSiteSettings(A)
    expect(s.catalogActive).toBe(true)
    expect(s.minimumOrderAmount).toBe(300)
    expect(s.chrome).toEqual(DEFAULT_SITE_CHROME)
  })

  it('erro que NÃO é de coluna ausente continua falhando fechado (nunca abre o catálogo por padrão)', async () => {
    ;(createAdminClient as any).mockImplementation(() => adminMissing(['site_chrome'], { code: '57014', message: 'canceling statement due to statement timeout' }))
    await expect(getWholesaleSiteSettings(A)).rejects.toThrow(/statement timeout/)
  })
})
