import { describe, it, expect } from 'vitest'
import { resolveClientIp } from './clientIp'

const h = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] ?? null })

describe('resolveClientIp — nunca confia em cabeçalho do cliente sem proxy declarado', () => {
  it('sem configuração: desconhecido, mesmo com X-Forwarded-For e X-Real-IP', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7' }), {})).toEqual({ ip: null, source: 'unknown' })
  })

  it('cabeçalho configurado: usa o valor validado; IPv6 e IPv4 com porta', () => {
    const env = { WHOLESALE_CLIENT_IP_HEADER: 'X-Real-IP' }
    expect(resolveClientIp(h({ 'x-real-ip': '198.51.100.1' }), env)).toEqual({ ip: '198.51.100.1', source: 'header' })
    expect(resolveClientIp(h({ 'x-real-ip': '198.51.100.1:51234' }), env).ip).toBe('198.51.100.1')
    expect(resolveClientIp(h({ 'x-real-ip': '2001:db8::1' }), env).ip).toBe('2001:db8::1')
  })

  it('cabeçalho configurado ausente/inválido: desconhecido, sem fallback para X-Forwarded-For', () => {
    const env = { WHOLESALE_CLIENT_IP_HEADER: 'x-real-ip' }
    expect(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), env).ip).toBeNull()
    expect(resolveClientIp(h({ 'x-real-ip': 'abc' }), env).ip).toBeNull()
    expect(resolveClientIp(h({ 'x-real-ip': '999.1.1.1' }), env).ip).toBeNull()
  })

  it('HOPS=1: pega a entrada da DIREITA (a do proxy); o que o cliente forjou à esquerda é ignorado', () => {
    const env = { WHOLESALE_TRUSTED_PROXY_HOPS: '1' }
    expect(resolveClientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 198.51.100.7' }), env)).toEqual({ ip: '198.51.100.7', source: 'forwarded-hops' })
  })

  it('HOPS=2 (CDN + proxy): a segunda da direita; cadeia curta demais → desconhecido', () => {
    const env = { WHOLESALE_TRUSTED_PROXY_HOPS: '2' }
    expect(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.9' }), env).ip).toBe('198.51.100.7')
    expect(resolveClientIp(h({ 'x-forwarded-for': '198.51.100.7' }), env).ip).toBeNull()
  })

  it('HOPS inválido (0, negativo, texto, muito alto) é ignorado → desconhecido', () => {
    for (const hops of ['0', '-1', 'x', '99']) {
      expect(resolveClientIp(h({ 'x-forwarded-for': '198.51.100.7' }), { WHOLESALE_TRUSTED_PROXY_HOPS: hops }).ip).toBeNull()
    }
  })

  it('o cabeçalho configurado tem precedência sobre HOPS', () => {
    const env = { WHOLESALE_CLIENT_IP_HEADER: 'x-real-ip', WHOLESALE_TRUSTED_PROXY_HOPS: '1' }
    expect(resolveClientIp(h({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), env).ip).toBe('198.51.100.1')
  })
})
