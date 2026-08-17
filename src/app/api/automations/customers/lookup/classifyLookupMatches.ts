export type LookupNotFoundReason = 'not_found' | 'ambiguous' | 'invalid_phone'

export type LookupResult =
  | { found: true; customer_id: number; name: string; phone_e164: string }
  | { found: false; reason: LookupNotFoundReason }

export interface CustomerLookupRow {
  id: number
  name: string
  phone_e164: string
}

/**
 * Pura, exportada pra teste — classifica o resultado de uma busca por
 * telefone sem tocar banco (seção 7 do pedido: nunca escolhe um customer
 * arbitrariamente entre duplicados, nunca retorna a lista pro n8n).
 *
 * Vive fora de route.ts porque o Next.js App Router só aceita exports
 * específicos (GET/POST/dynamic/...) em arquivos route.ts — qualquer outro
 * export quebra o build ("is not a valid Route export field").
 */
export function classifyLookupMatches(matches: CustomerLookupRow[]): LookupResult {
  if (matches.length === 0) return { found: false, reason: 'not_found' }
  if (matches.length > 1) return { found: false, reason: 'ambiguous' }
  const customer = matches[0]
  return { found: true, customer_id: customer.id, name: customer.name, phone_e164: customer.phone_e164 }
}
