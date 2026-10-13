/**
 * IP do cliente para o rate limiting dos pedidos do atacado — SEM confiar em cabeçalho que o cliente controla.
 *
 * Cabeçalhos `X-Forwarded-For`/`X-Real-IP` podem ser forjados por quem chama a API. O app só usa um valor quando a
 * configuração DECLARA qual proxy é confiável:
 *
 *  1. `WHOLESALE_CLIENT_IP_HEADER=<nome>`: cabeçalho que a borda confiável SOBRESCREVE (ex.: `cf-connecting-ip`,
 *     `x-real-ip` do Traefik). Só é seguro se o app for alcançável APENAS por esse proxy.
 *  2. `WHOLESALE_TRUSTED_PROXY_HOPS=N`: número de proxies confiáveis à frente do app. Usa a N-ésima entrada a partir
 *     da DIREITA de `X-Forwarded-For` — a que o proxy mais próximo acrescentou. Entradas à esquerda (forjadas pelo
 *     cliente) são ignoradas. Traefik direto = 1; CDN + Traefik = 2.
 *
 * Sem nenhuma das duas, NADA é confiável: o IP é "desconhecido" (`ip: null`) e o pedido cai no balde de IP
 * desconhecido (limite próprio, ver orders.ts) — nunca em "sem limite por IP".
 */

import { isIP } from 'node:net'

export type IpSource = 'header' | 'forwarded-hops' | 'unknown'

export interface ResolvedClientIp {
  /** IP validado e confiável, ou `null` (desconhecido). */
  ip: string | null
  source: IpSource
}

function validIp(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  // IPv4 com porta ("1.2.3.4:5678") — remove a porta antes de validar.
  const withoutPort = /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value) ? value.replace(/:\d+$/, '') : value
  return isIP(withoutPort) ? withoutPort : null
}

export function resolveClientIp(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
): ResolvedClientIp {
  const headerName = env.WHOLESALE_CLIENT_IP_HEADER?.trim().toLowerCase()
  if (headerName) {
    // Cabeçalho único definido pela borda confiável; valor inválido = desconhecido (nunca cai para XFF).
    const ip = validIp(headers.get(headerName)?.split(',')[0])
    return ip ? { ip, source: 'header' } : { ip: null, source: 'unknown' }
  }

  const hops = Number(env.WHOLESALE_TRUSTED_PROXY_HOPS)
  if (Number.isInteger(hops) && hops >= 1 && hops <= 5) {
    const chain = (headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    // Cadeia mais curta que o nº de proxies confiáveis: a borda não passou por onde a config diz → desconhecido.
    const ip = chain.length >= hops ? validIp(chain[chain.length - hops]) : null
    return ip ? { ip, source: 'forwarded-hops' } : { ip: null, source: 'unknown' }
  }

  return { ip: null, source: 'unknown' }
}
