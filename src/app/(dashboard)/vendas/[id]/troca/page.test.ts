// Regressão — remoção da autorização de gerente na troca (pedido do
// usuário 2026-08-28, corrigindo o commit 7b47e43 que criava uma exceção
// por UUID): nenhum perfil autenticado recebe AuthorizationModal na troca.
// Sem jsdom/Testing Library neste repo — inspeção de código-fonte é o
// padrão já usado em vendas/[id]/page.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE_SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')
const FORM_SOURCE  = readFileSync(join(__dirname, 'ExchangeForm.tsx'), 'utf-8')

describe('vendas/[id]/troca/page — nenhum perfil precisa de autorização de gerente/admin', () => {
  it('page.tsx não calcula mais requiresAuth nem depende de profile.role', () => {
    expect(PAGE_SOURCE).not.toMatch(/requiresAuth/)
    expect(PAGE_SOURCE).not.toMatch(/profile\?\.role/)
  })

  it('page.tsx não busca mais profile/getUserProfile — não tem mais motivo pra isso na troca', () => {
    expect(PAGE_SOURCE).not.toMatch(/getUserProfile/)
  })

  it('page.tsx não tem nenhuma lógica baseada no UUID liberado nem no helper removido', () => {
    expect(PAGE_SOURCE).not.toMatch(/exchangeAuthorizationExemptions/)
    expect(PAGE_SOURCE).not.toMatch(/f9065bc1-7f6d-49bb-b192-f044d31541ca/)
  })

  it('ExchangeForm não importa nem renderiza mais o AuthorizationModal', () => {
    expect(FORM_SOURCE).not.toMatch(/AuthorizationModal/)
  })

  it('ExchangeForm não tem mais prop requiresAuth nem estado showAuthModal', () => {
    expect(FORM_SOURCE).not.toMatch(/requiresAuth/)
    expect(FORM_SOURCE).not.toMatch(/showAuthModal/)
  })

  it('handleSubmit chama doSubmit() diretamente, sem branch condicional de autorização', () => {
    expect(FORM_SOURCE).toMatch(/function handleSubmit\(\) \{[\s\S]*?doSubmit\(\)[\s\S]*?\}/)
  })
})
