/** Resposta de POST /oauth/token (doc oficial). */
export interface MercadoLivreTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
  user_id: number
  refresh_token: string
}

/** Subconjunto de GET /users/me que o Qarvon usa/persiste. */
export interface MercadoLivreMe {
  id: number
  nickname?: string
  site_id?: string
  country_id?: string
  permalink?: string
  tags?: string[]
  first_name?: string
  last_name?: string
}

/**
 * Metadado NÃO sensível da conta conectada, persistido em
 * company_integrations.settings. Deliberadamente mínimo (sem e-mail,
 * documento, endereço, telefone).
 */
export interface MercadoLivreAccountSettings {
  seller_id: string
  nickname: string | null
  site_id: string
  country_id: string | null
  permalink: string | null
  /** Conta TEST do Mercado Livre (tag `test_user`). Não muda endpoint — não existe sandbox. */
  is_test_user: boolean
}

export interface MercadoLivreTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
  userId: string
}

export function accountSettingsFromMe(me: MercadoLivreMe, fallbackSiteId: string): MercadoLivreAccountSettings {
  return {
    seller_id: String(me.id),
    nickname: me.nickname ?? null,
    site_id: (me.site_id ?? fallbackSiteId).toUpperCase(),
    country_id: me.country_id ?? null,
    permalink: me.permalink ?? null,
    is_test_user: Array.isArray(me.tags) && me.tags.includes('test_user'),
  }
}
