import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleSiteSettings, updateWholesaleSiteSettings } from './settings'
import { EMPTY_SITE_TEXTS } from './siteTexts'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntity: vi.fn() }))

const A = 1
const B = 2
let tables: FakeTables

beforeEach(() => {
  tables = { wholesale_site_settings: [] }
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => createFakeAdmin(tables))
})

describe('textos do atacado — persistência e recuperação', () => {
  it('sem linha: padrões (todos null) e pedido mínimo comercial intacto', async () => {
    const s = await getWholesaleSiteSettings(A)
    expect(s.texts).toEqual(EMPTY_SITE_TEXTS)
    expect(s.minimumOrderAmount).toBe(300)
  })

  it('salva e recupera os 8 textos, vinculados ao company_id', async () => {
    const saved = await updateWholesaleSiteSettings(A, {
      texts: { heroTitle: 'Moda íntima', heroSubtitle: 'Atacado', categoriesTitle: 'Coleções', productsTitle: 'Todas as peças', addAlsoTitle: 'Leve mais', minimumOrderNote: 'Frete combinado', emptyMessage: 'Sem peças', footerText: 'L1\nL2' },
    })
    expect(saved.ok).toBe(true)
    expect(tables.wholesale_site_settings).toHaveLength(1)
    expect(tables.wholesale_site_settings[0]).toMatchObject({ company_id: A, hero_title: 'Moda íntima', footer_text: 'L1\nL2', add_also_title: 'Leve mais' })

    const loaded = await getWholesaleSiteSettings(A)
    expect(loaded.texts).toEqual({ heroTitle: 'Moda íntima', heroSubtitle: 'Atacado', categoriesTitle: 'Coleções', productsTitle: 'Todas as peças', addAlsoTitle: 'Leve mais', minimumOrderNote: 'Frete combinado', emptyMessage: 'Sem peças', footerText: 'L1\nL2' })
  })

  it('alteração aparece na leitura seguinte (site público não precisa de deploy)', async () => {
    await updateWholesaleSiteSettings(A, { texts: { categoriesTitle: 'Antes' } })
    expect((await getWholesaleSiteSettings(A)).texts.categoriesTitle).toBe('Antes')
    await updateWholesaleSiteSettings(A, { texts: { categoriesTitle: 'Depois' } })
    expect((await getWholesaleSiteSettings(A)).texts.categoriesTitle).toBe('Depois')
  })

  it('atualização parcial mantém os outros textos; null volta ao padrão', async () => {
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'T', footerText: 'F' } })
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: null } })
    const s = await getWholesaleSiteSettings(A)
    expect(s.texts.heroTitle).toBeNull()
    expect(s.texts.footerText).toBe('F')
  })

  it('salvar textos não mexe nas regras comerciais (mínimo, WhatsApp, catálogo ativo)', async () => {
    await updateWholesaleSiteSettings(A, { minimumOrderAmount: 450, whatsappPhone: '84999999999', catalogActive: false })
    await updateWholesaleSiteSettings(A, { texts: { minimumOrderNote: 'Texto livre: R$ 1,00' } })
    const s = await getWholesaleSiteSettings(A)
    expect(s).toMatchObject({ minimumOrderAmount: 450, whatsappPhone: '84999999999', catalogActive: false })
    expect(s.texts.minimumOrderNote).toBe('Texto livre: R$ 1,00')
  })

  it('salvar regras comerciais sem enviar textos não apaga os textos', async () => {
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'Fica' } })
    await updateWholesaleSiteSettings(A, { minimumOrderAmount: 500 })
    expect((await getWholesaleSiteSettings(A)).texts.heroTitle).toBe('Fica')
  })
})

describe('isolamento multi-tenant', () => {
  it('textos de uma empresa nunca aparecem na outra', async () => {
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'Da A', footerText: 'Rodapé A' } })
    await updateWholesaleSiteSettings(B, { texts: { heroTitle: 'Da B' } })

    expect((await getWholesaleSiteSettings(A)).texts).toMatchObject({ heroTitle: 'Da A', footerText: 'Rodapé A' })
    expect((await getWholesaleSiteSettings(B)).texts).toMatchObject({ heroTitle: 'Da B', footerText: null })
    expect(tables.wholesale_site_settings).toHaveLength(2)
  })

  it('empresa sem linha enxerga só padrões, mesmo existindo texto de outra', async () => {
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'Da A' } })
    expect((await getWholesaleSiteSettings(3)).texts).toEqual(EMPTY_SITE_TEXTS)
  })
})
