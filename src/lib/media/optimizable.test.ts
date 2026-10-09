import { describe, it, expect, beforeEach } from 'vitest'
import { isOptimizableImageUrl } from './optimizable'

beforeEach(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://qarvon-supabase.uxxkgy.easypanel.host' })

describe('isOptimizableImageUrl — mesma allowlist do next.config.js', () => {
  it('aceita o bucket público do host configurado e Supabase Cloud', () => {
    expect(isOptimizableImageUrl('https://qarvon-supabase.uxxkgy.easypanel.host/storage/v1/object/public/media-public/1/a.jpg')).toBe(true)
    expect(isOptimizableImageUrl('https://abc.supabase.co/storage/v1/object/public/media-public/1/a.jpg')).toBe(true)
  })

  it('rejeita host externo, outro bucket, protocolo errado, URL inválida ou vazia', () => {
    expect(isOptimizableImageUrl('https://cdn.nuvemshop.com.br/x.jpg')).toBe(false)
    expect(isOptimizableImageUrl('https://qarvon-supabase.uxxkgy.easypanel.host/storage/v1/object/public/media-private/1/a.jpg')).toBe(false)
    expect(isOptimizableImageUrl('http://qarvon-supabase.uxxkgy.easypanel.host/storage/v1/object/public/media-public/1/a.jpg')).toBe(false)
    expect(isOptimizableImageUrl('https://qarvon-supabase.uxxkgy.easypanel.host.evil.com/storage/v1/object/public/media-public/a.jpg')).toBe(false)
    expect(isOptimizableImageUrl('nao-e-url')).toBe(false)
    expect(isOptimizableImageUrl(null)).toBe(false)
  })
})
