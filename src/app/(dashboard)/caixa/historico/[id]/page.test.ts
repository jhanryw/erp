// Conferência cega (auditoria + correção 2026-09-10) — regressão estática,
// mesmo padrão de src/app/comprovante/[token]/page.test.ts (sem Testing
// Library/jsdom pra Server Components neste repo).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')
const CODE_ONLY = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

describe('/caixa/historico/[id] — detalhe não vaza esperado/diferença pra usuario/seller', () => {
  it('"Esperado em caixa" só renderiza dentro de um guard canSeeExpected', () => {
    const idx = CODE_ONLY.indexOf('Esperado em caixa')
    expect(idx).toBeGreaterThan(-1)
    const before = CODE_ONLY.slice(Math.max(0, idx - 200), idx)
    expect(before).toMatch(/canSeeExpected/)
  })

  it('a Row de "Diferença" está dentro do mesmo guard', () => {
    const idx = CODE_ONLY.indexOf('label="Diferença"')
    expect(idx).toBeGreaterThan(-1)
    const before = CODE_ONLY.slice(Math.max(0, idx - 200), idx)
    expect(before).toMatch(/canSeeExpected/)
  })

  it('"Contado" (o que o próprio funcionário informou) continua fora do guard — não é o dado sensível', () => {
    const idx = CODE_ONLY.indexOf('label="Contado"')
    expect(idx).toBeGreaterThan(-1)
    const before = CODE_ONLY.slice(Math.max(0, idx - 80), idx)
    expect(before).not.toMatch(/canSeeExpected &&\s*\($/)
  })

  it('select(*) foi substituído por lista explícita de campos condicionada a canSeeExpected', () => {
    expect(CODE_ONLY).not.toMatch(/\.select\('\*'\)/)
    expect(CODE_ONLY).toMatch(/canSeeExpected \? `\$\{baseFields\}, expected_cash, cash_difference`/)
  })

  it('getSession recebe canSeeExpected calculado com hasMinRole antes de ser chamado', () => {
    expect(CODE_ONLY).toMatch(/const canSeeExpected = hasMinRole\(profile\.role, 'gerente'\)/)
    expect(CODE_ONLY).toMatch(/getSession\(id, profile\.company_id, canSeeExpected\)/)
  })
})
