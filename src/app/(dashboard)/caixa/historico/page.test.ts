// Conferência cega (auditoria + correção 2026-09-10) — regressão estática.
// Sem Testing Library/jsdom neste repo pra Server Components (mesmo padrão
// de src/app/comprovante/[token]/page.test.ts): inspeciona o código-fonte
// pra travar que "Esperado em caixa" e "Diferença" nunca renderizam fora de
// um guard de canSeeExpected/hasMinRole, e que a query ao banco também é
// condicionada (não só o JSX).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')
const CODE_ONLY = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

describe('/caixa/historico — lista não vaza esperado/diferença pra usuario/seller', () => {
  it('usa hasMinRole/canSeeExpected pra decidir visibilidade (não é role hardcoded solto)', () => {
    expect(CODE_ONLY).toMatch(/hasMinRole\(profile\.role, 'gerente'\)/)
    expect(CODE_ONLY).toMatch(/canSeeExpected/)
  })

  it('a coluna "Diferença" (cabeçalho e célula) está condicionada a canSeeExpected', () => {
    const headerLine = CODE_ONLY.split('\n').find((l) => l.includes('Diferença'))
    expect(headerLine).toBeDefined()
    expect(headerLine).toMatch(/canSeeExpected/)
  })

  it('getSessions só busca expected_cash/cash_difference quando canSeeExpected é true', () => {
    expect(CODE_ONLY).toMatch(/canSeeExpected \? `\$\{baseFields\}, expected_cash, cash_difference`/)
    // baseFields (usado sempre) não pode conter os dois campos sensíveis
    const baseFieldsMatch = CODE_ONLY.match(/const baseFields = `([\s\S]*?)`/)
    expect(baseFieldsMatch).toBeTruthy()
    expect(baseFieldsMatch![1]).not.toMatch(/expected_cash|cash_difference/)
  })

  it('dinheiroFisico não cai de volta pra expected_cash (sem fallback perigoso)', () => {
    expect(CODE_ONLY).not.toMatch(/counted_cash \?\? s\.expected_cash/)
  })
})
