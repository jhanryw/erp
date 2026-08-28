// Regressão — remoção da autorização de gerente EXCLUSIVAMENTE pra troca
// (2026-08-28). Este arquivo prova, por inspeção de código-fonte, que
// cancelamento, devolução e desconto em venda nova continuam exigindo
// authorization_token_id/validateAuthorizationToken normalmente — a
// simplificação da troca não vazou pra nenhuma outra operação sensível.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf-8')
}

describe('cancelamento/devolução/desconto continuam exigindo autorização de gerente', () => {
  it('cancelamento de venda: continua chamando validateAuthorizationToken pra role usuario', () => {
    const src = source('src/app/api/vendas/[id]/cancelar/route.ts')
    expect(src).toMatch(/validateAuthorizationToken/)
    expect(src).toMatch(/user\.role === 'usuario'/)
  })

  it('devolução de venda: continua chamando validateAuthorizationToken pra role usuario', () => {
    const src = source('src/app/api/vendas/[id]/devolucao/route.ts')
    expect(src).toMatch(/validateAuthorizationToken/)
    expect(src).toMatch(/user\.role === 'usuario'/)
  })

  it('desconto em nova venda (apply_discount): continua chamando validateAuthorizationToken quando o token é enviado', () => {
    const src = source('src/app/api/vendas/route.ts')
    expect(src).toMatch(/validateAuthorizationToken/)
    expect(src).toMatch(/discount_authorization_token_id/)
  })

  it('troca: não importa mais validateAuthorizationToken nem AuthorizationModal em lugar nenhum do fluxo', () => {
    const routeSrc = source('src/app/api/vendas/[id]/troca/route.ts')
    const formSrc  = source('src/app/(dashboard)/vendas/[id]/troca/ExchangeForm.tsx')
    expect(routeSrc).not.toMatch(/validateAuthorizationToken/)
    expect(formSrc).not.toMatch(/AuthorizationModal/)
  })

  it('nenhum arquivo de código (fora de teste) referencia mais o helper de exceção removido', () => {
    const grep: string[] = require('node:child_process').execSync(
      "grep -rl 'exchangeAuthorizationExemptions\\|f9065bc1-7f6d-49bb-b192-f044d31541ca' src || true",
      { cwd: process.cwd(), encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean)
    const nonTestFiles = grep.filter((f) => !f.includes('.test.'))
    expect(nonTestFiles).toEqual([])
  })
})
