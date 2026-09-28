/** Resposta de /api/v2/auth/token/get e /api/v2/auth/access_token/get (campos usados). */
export interface ShopeeTokenResponse {
  access_token?: string
  refresh_token?: string
  expire_in?: number
  shop_id?: number
  shop_id_list?: number[]
  merchant_id_list?: number[]
  request_id?: string
  error?: string
  message?: string
}

export interface ShopeeTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  shopId: string
}

/** Metadado NÃO sensível da loja conectada, persistido em company_integrations.settings. */
export interface ShopeeShopSettings {
  shop_id: string
}
