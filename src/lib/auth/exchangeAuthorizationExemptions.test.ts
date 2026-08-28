// Regressão — liberação pontual de autorização de gerente pra troca
// (pedido do usuário 2026-08-28): apenas o UUID explicitamente listado é
// exemptado, nenhum outro seller/role ganha a exceção por acidente.
import { describe, it, expect } from 'vitest'
import { isExemptFromExchangeAuthorization } from './exchangeAuthorizationExemptions'

const EXEMPT_SELLER_UUID = 'f9065bc1-7f6d-49bb-b192-f044d31541ca'

describe('isExemptFromExchangeAuthorization', () => {
  it('retorna true para o UUID explicitamente liberado', () => {
    expect(isExemptFromExchangeAuthorization(EXEMPT_SELLER_UUID)).toBe(true)
  })

  it('retorna false para qualquer outro UUID (nenhuma liberação automática pra outros sellers)', () => {
    expect(isExemptFromExchangeAuthorization('00000000-0000-0000-0000-000000000001')).toBe(false)
    expect(isExemptFromExchangeAuthorization('user-uuid')).toBe(false)
  })

  it('não faz match parcial/case-insensitive por engano', () => {
    expect(isExemptFromExchangeAuthorization(EXEMPT_SELLER_UUID.toUpperCase())).toBe(false)
    expect(isExemptFromExchangeAuthorization(EXEMPT_SELLER_UUID.slice(0, -1))).toBe(false)
  })
})
