/**
 * Wrapper server-only de site-host.ts — único ponto que lê o header Host
 * da requisição atual via `next/headers` (Server Components/Route
 * Handlers). Mantido separado de site-host.ts de propósito: site-host.ts
 * fica 100% puro (testável sem runtime do Next), este arquivo nunca é
 * importado por componente client (só por page.tsx/layout.tsx server e
 * route handlers).
 */

import { headers } from 'next/headers'
import { resolveWholesaleBasePath } from './site-host'

/** `''` no host de atacado (link limpo), `/atacado` em qualquer outro host. */
export function getWholesaleBasePath(): string {
  return resolveWholesaleBasePath(headers().get('host'))
}
