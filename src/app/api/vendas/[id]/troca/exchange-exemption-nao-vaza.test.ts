// Regressão — liberação pontual de autorização pra troca (2026-08-28): a
// exceção do seller UUID f9065bc1-7f6d-49bb-b192-f044d31541ca vale
// EXCLUSIVAMENTE pra troca. Este arquivo prova, por inspeção de
// código-fonte, que cancelamento e devolução de venda continuam exigindo
// authorization_token_id de gerente para role `usuario` sem exceção — o
// helper isExemptFromExchangeAuthorization não foi importado ali.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf-8')
}

describe('exceção de autorização de troca não vaza para outras operações sensíveis', () => {
  it('cancelamento de venda: continua exigindo token de gerente pra usuario, sem exceção por UUID', () => {
    const src = source('src/app/api/vendas/[id]/cancelar/route.ts')
    expect(src).toMatch(/user\.role === 'usuario'/)
    expect(src).not.toMatch(/isExemptFromExchangeAuthorization/)
    expect(src).not.toMatch(/f9065bc1-7f6d-49bb-b192-f044d31541ca/)
  })

  it('devolução de venda: continua exigindo token de gerente pra usuario, sem exceção por UUID', () => {
    const src = source('src/app/api/vendas/[id]/devolucao/route.ts')
    expect(src).toMatch(/user\.role === 'usuario'/)
    expect(src).not.toMatch(/isExemptFromExchangeAuthorization/)
    expect(src).not.toMatch(/f9065bc1-7f6d-49bb-b192-f044d31541ca/)
  })

  it('desconto em nova venda (apply_discount): sem exceção por UUID', () => {
    const src = source('src/app/api/vendas/route.ts')
    expect(src).not.toMatch(/isExemptFromExchangeAuthorization/)
    expect(src).not.toMatch(/f9065bc1-7f6d-49bb-b192-f044d31541ca/)
  })

  it('o UUID liberado aparece em exatamente um arquivo de CÓDIGO (fora de testes): o helper centralizado', () => {
    const grep: string[] = require('node:child_process').execSync(
      "grep -rl 'f9065bc1-7f6d-49bb-b192-f044d31541ca' src",
      { cwd: process.cwd(), encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean)
    const nonTestFiles = grep.filter((f) => !f.includes('.test.'))
    expect(nonTestFiles).toEqual(['src/lib/auth/exchangeAuthorizationExemptions.ts'])
  })
})
