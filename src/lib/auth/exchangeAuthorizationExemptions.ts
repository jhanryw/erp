/**
 * Sellers explicitamente liberados a concluir trocas sem autorização de
 * gerente (email/senha via AuthorizationModal). Decisão de produto pontual
 * (2026-08-28) — é uma exceção nominal por UUID, não uma mudança da regra
 * pra todo o role `usuario`. Antes de adicionar outro UUID aqui, confirmar
 * se o pedido não é na verdade "liberar pra todos os sellers" — isso
 * exigiria repensar a regra em `requiresAuth`/`route.ts`, não crescer esta
 * lista.
 */
const EXCHANGE_AUTHORIZATION_EXEMPT_USER_IDS: readonly string[] = [
  'f9065bc1-7f6d-49bb-b192-f044d31541ca',
]

export function isExemptFromExchangeAuthorization(userId: string): boolean {
  return EXCHANGE_AUTHORIZATION_EXEMPT_USER_IDS.includes(userId)
}
