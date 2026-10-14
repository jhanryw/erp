/**
 * Marcador de contato anônimo (módulo PURO, sem `node:crypto`): pode ser importado por componentes de cliente.
 * A geração do telefone fictício fica em `anonymousCustomer.ts` (somente servidor). Contexto completo lá.
 */

export const ANONYMOUS_CUSTOMER_NAME = 'Cliente do site'

export const RESERVED_PREFIX = '+5500'

export function isAnonymousPhone(e164: string | null | undefined): boolean {
  return !!e164 && e164.startsWith(RESERVED_PREFIX) && /^\+55[0-9]{10,11}$/.test(e164)
}

/** Pedido sem contato real: telefone NULL (migration aplicada) ou marcador fictício (legado/antes da migration). */
export function isAnonymousContact(phone: string | null | undefined): boolean {
  return phone == null || isAnonymousPhone(phone)
}
