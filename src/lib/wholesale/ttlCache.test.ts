import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cachedForCompany, configureWholesaleCache, invalidateWholesaleCompany, cacheTtlMs } from './ttlCache'

beforeEach(() => { vi.useFakeTimers(); configureWholesaleCache({ ttlMs: 30_000 }) })
afterEach(() => { vi.useRealTimers(); configureWholesaleCache({ ttlMs: null }) })

describe('ttlCache', () => {
  it('em testes o cache fica desligado por padrão (cada chamada lê a fonte)', () => {
    configureWholesaleCache({ ttlMs: null })
    expect(cacheTtlMs()).toBe(0)
  })

  it('reaproveita dentro do TTL e recarrega depois dele', async () => {
    const loader = vi.fn(async () => Math.random())
    const a = await cachedForCompany(1, 'k', loader)
    const b = await cachedForCompany(1, 'k', loader)
    expect(b).toBe(a)
    expect(loader).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_001)
    await cachedForCompany(1, 'k', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('isolamento: a mesma chave em empresas diferentes nunca compartilha valor', async () => {
    const a = await cachedForCompany(1, 'settings', async () => 'da-empresa-1')
    const b = await cachedForCompany(2, 'settings', async () => 'da-empresa-2')
    expect([a, b]).toEqual(['da-empresa-1', 'da-empresa-2'])
  })

  it('single-flight: chamadas simultâneas compartilham UMA carga', async () => {
    const loader = vi.fn(async () => { await Promise.resolve(); return 'x' })
    await Promise.all([cachedForCompany(1, 'k', loader), cachedForCompany(1, 'k', loader), cachedForCompany(1, 'k', loader)])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('invalida só a empresa pedida', async () => {
    const l1 = vi.fn(async () => 'v1'); const l2 = vi.fn(async () => 'v2')
    await cachedForCompany(1, 'k', l1); await cachedForCompany(2, 'k', l2)
    invalidateWholesaleCompany(1)
    await cachedForCompany(1, 'k', l1); await cachedForCompany(2, 'k', l2)
    expect(l1).toHaveBeenCalledTimes(2)
    expect(l2).toHaveBeenCalledTimes(1)
  })

  it('erro nunca é cacheado', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('falha')).mockResolvedValueOnce('ok')
    await expect(cachedForCompany(1, 'k', loader)).rejects.toThrow('falha')
    await expect(cachedForCompany(1, 'k', loader)).resolves.toBe('ok')
  })
})
