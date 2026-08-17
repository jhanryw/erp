export interface ChatwootIntegrationLike {
  status: string
  settings: Record<string, unknown>
}

/**
 * Pura, exportada pra teste — resolve a URL do botão "Abrir Chatwoot" a
 * partir da integração já buscada server-side (Fase "Espelhar Chatwoot no
 * ERP"). Só considera integração `provider='chatwoot'` com `status='active'`
 * e `settings.base_url` configurado — nunca usa `inbox_id`/`api_token`/
 * qualquer outro campo, e nunca confia em `base_url` de tipo errado.
 */
export function resolveChatwootLauncherUrl(integration: ChatwootIntegrationLike | null): string | null {
  if (!integration || integration.status !== 'active') return null
  const baseUrl = integration.settings.base_url
  if (typeof baseUrl !== 'string') return null
  const trimmed = baseUrl.trim()
  return trimmed || null
}
