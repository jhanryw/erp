import { describe, it, expect } from 'vitest'
import { wholesaleBannerLinkSchema } from './banners'

describe('wholesaleBannerLinkSchema — seção 19 do pedido', () => {
  it('aceita "none" sem campos extra', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'none' }).success).toBe(true)
  })

  it('aceita "category" com categorySlug', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'category', categorySlug: 'calcinhas' }).success).toBe(true)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'category' }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'category', categorySlug: '' }).success).toBe(false)
  })

  it('aceita "product" com productId inteiro positivo', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'product', productId: 42 }).success).toBe(true)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'product', productId: -1 }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'product', productId: 1.5 }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'product' }).success).toBe(false)
  })

  it('aceita URL http:/https:', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'https://exemplo.com/promo' }).success).toBe(true)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'http://exemplo.com' }).success).toBe(true)
  })

  it('rejeita esquemas perigosos (javascript:, data:) e qualquer coisa fora de http/https', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'javascript:alert(1)' }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'data:text/html,<script>alert(1)</script>' }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'ftp://exemplo.com' }).success).toBe(false)
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'url', url: 'not-a-url' }).success).toBe(false)
  })

  it('rejeita tipo desconhecido', () => {
    expect(wholesaleBannerLinkSchema.safeParse({ type: 'internal', path: '/x' }).success).toBe(false)
  })
})
