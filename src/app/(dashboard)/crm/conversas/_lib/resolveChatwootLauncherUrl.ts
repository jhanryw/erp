export interface ChatwootIntegrationLike {
  status: string
  settings: Record<string, unknown>
  external_account_id: string | null
}

/**
 * Pura, exportada pra teste — resolve a URL do botão "Abrir Chatwoot" a
 * partir da integração já buscada server-side. Só considera integração
 * `provider='chatwoot'` com `status='active'`, `settings.base_url` e
 * `external_account_id` configurados — nunca usa `inbox_id`/`api_token`/
 * qualquer outro campo, e nunca confia em valor de tipo errado.
 *
 * Monta o link direto pra tela de inbox do Chatwoot (`/app/accounts/:id/inbox-view`)
 * — `account_id` vem de `external_account_id` (já armazenado desde a Fase
 * 4B), nunca hardcoded no componente (Fase "Auditoria de remoção da inbox
 * legada" — o "1" do link operacional passado pelo usuário é o valor REAL
 * de `external_account_id` da Santtorini hoje, não uma constante).
 */
export function resolveChatwootLauncherUrl(integration: ChatwootIntegrationLike | null): string | null {
  if (!integration || integration.status !== 'active') return null

  const baseUrl = integration.settings.base_url
  if (typeof baseUrl !== 'string') return null
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmedBase) return null

  const accountId = integration.external_account_id
  if (!accountId || !accountId.trim()) return null

  return `${trimmedBase}/app/accounts/${encodeURIComponent(accountId.trim())}/inbox-view`
}
