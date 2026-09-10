// Conferência cega (auditoria + correção 2026-09-10) — regressão estática.
// Este componente é client-side ('use client') e o repo não tem Testing
// Library/jsdom configurado (ver src/app/comprovante/[token]/page.test.ts
// pro mesmo padrão em Server Component) — trava por inspeção de
// código-fonte que a UI do seller não recalcula nem exibe
// esperado/diferença, e que o fluxo de divergência mantém o form aberto
// sem fechar a sessão.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')
const CODE_ONLY = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

describe('/caixa (seller) — sem cálculo client-side de diferença, sem exibir esperado', () => {
  it('não existe mais cálculo de diferença no cliente (counted - expected)', () => {
    expect(CODE_ONLY).not.toMatch(/counted\s*-\s*expectedCash/)
    expect(CODE_ONLY).not.toMatch(/Valores conferem/)
    expect(CODE_ONLY).not.toMatch(/não confere com o esperado/)
  })

  it('o card "Dinheiro esperado no caixa" só renderiza sob isManager', () => {
    const idx = CODE_ONLY.indexOf('Dinheiro esperado no caixa')
    expect(idx).toBeGreaterThan(-1)
    const before = CODE_ONLY.slice(Math.max(0, idx - 200), idx)
    expect(before).toMatch(/isManager && expectedCash/)
  })

  it('a prévia (GET /api/caixa/fechar) só é buscada quando isManager é true', () => {
    expect(CODE_ONLY).toMatch(/if \(!isManager\) return/)
  })

  it('isManager vem de hasMinRole(userRole, \'gerente\') via useUserContext — não é lido de props livres', () => {
    expect(CODE_ONLY).toMatch(/useUserContext/)
    expect(CODE_ONLY).toMatch(/hasMinRole\(userRole, 'gerente'\)/)
  })

  it('label do campo de contagem não embute mais o valor esperado', () => {
    expect(CODE_ONLY).not.toMatch(/esperado: \$\{formatCurrency\(expectedCash\)\}/)
  })

  it('divergência: mantém o form aberto (não reseta showClose/closeCounted) e não chama fetchSession', () => {
    const match = CODE_ONLY.match(/if \(json\.mismatch\) \{([\s\S]*?)\n\s*\}/)
    expect(match).toBeTruthy()
    const block = match![1]
    expect(block).not.toMatch(/setShowClose\(false\)/)
    expect(block).not.toMatch(/fetchSession\(\)/)
    expect(block).not.toMatch(/setCloseCounted\(''\)/)
  })

  it('mensagem de divergência vem do backend (json.message), com fallback neutro fixo — não é derivada de nenhum número', () => {
    expect(CODE_ONLY).toMatch(/setMismatchMessage\(json\.message \?\? BLIND_MISMATCH_FALLBACK\)/)
    expect(CODE_ONLY).not.toMatch(/setMismatchMessage\([^)]*expectedCash/)
  })
})
