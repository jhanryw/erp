/**
 * Pedido de atacado SEM nome/telefone digitados no carrinho.
 *
 * O cliente finaliza direto pelo WhatsApp (a conversa já traz o número dele). Como `wholesale_orders` exige
 * `customer_name` (2–120) e `customer_phone` (E.164 BR) NOT NULL e a RPC limita pedidos por telefone/hora,
 * o servidor grava uma identidade ANÔNIMA sem alterar o schema:
 *   - nome fixo "Cliente do site";
 *   - telefone reservado `+5500…` (DDD "00" não existe) derivado da chave de idempotência — único por pedido,
 *     logo o limite POR TELEFONE não agrupa visitantes diferentes. Os tetos por IP e por empresa continuam valendo.
 * O ERP e a mensagem de WhatsApp reconhecem o marcador e mostram "não informado", nunca o número fictício.
 */

import { createHash } from 'node:crypto'

export const ANONYMOUS_CUSTOMER_NAME = 'Cliente do site'

const RESERVED_PREFIX = '+5500'

/** `+5500` + 8 dígitos determinísticos da chave de idempotência (replay do mesmo pedido gera o mesmo valor). */
export function anonymousPhoneFor(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest()
  const n = digest.readUInt32BE(0) % 100_000_000
  return `${RESERVED_PREFIX}${String(n).padStart(8, '0')}`
}

export function isAnonymousPhone(e164: string | null | undefined): boolean {
  return !!e164 && e164.startsWith(RESERVED_PREFIX) && /^\+55[0-9]{10,11}$/.test(e164)
}
