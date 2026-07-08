/**
 * Normalização de telefone brasileiro para E.164 sem "+" (ex.: 5511999990000).
 *
 * Usado pela ingestão inbound do CRM (Fase 3, Entrega 3) para garantir que o
 * mesmo número, chegando em formatos de string diferentes (com/sem DDI,
 * pontuação, espaços), sempre resolve pra mesma crm_channel_identities.value
 * — sem isso, o mesmo cliente real viraria duas pessoas diferentes no CRM.
 *
 * Não substitui a normalização inline já existente no node "Parse payload"
 * do fluxo N8N de pós-venda nem em post-sale-context.ts — cada uma resolve
 * seu próprio fluxo, fora de escopo desta entrega tocar código já validado.
 */
export function normalizeE164BR(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return digits.startsWith('55') ? digits : `55${digits}`
}
