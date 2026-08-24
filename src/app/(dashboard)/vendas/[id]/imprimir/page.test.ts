// Regressão do crash real de produção (digest 655379705):
// "Event handlers cannot be passed to Client Component props" — causado por
// <button onClick={() => window.print()}> direto dentro deste Server
// Component (page.tsx, sem 'use client', não pode passar função nenhuma
// como prop pra elemento nenhum). Corrigido extraindo a parte interativa
// pra PrintButton.tsx ('use client'), mesmo padrão já usado em
// vendas/[id]/comprovante/PrintButton.tsx.
//
// Sem Testing Library/jsdom neste repo (não dá pra montar o Server
// Component de verdade e provar em runtime) — trava isso via inspeção do
// código-fonte, mirando especificamente o arquivo real que quebrou.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE_SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')
const PRINT_BUTTON_SOURCE = readFileSync(join(__dirname, 'PrintButton.tsx'), 'utf-8')
const PRINT_TRIGGER_SOURCE = readFileSync(join(__dirname, 'PrintTrigger.tsx'), 'utf-8')

const PAGE_CODE_ONLY = PAGE_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

describe('vendas/[id]/imprimir/page.tsx — Server Component nunca passa onClick (causa raiz do digest 655379705)', () => {
  it('page.tsx é Server Component (sem "use client")', () => {
    expect(PAGE_SOURCE.trimStart().startsWith("'use client'")).toBe(false)
  })

  it('page.tsx não contém nenhum onClick — a interatividade foi extraída pro PrintButton', () => {
    expect(PAGE_CODE_ONLY).not.toMatch(/onClick/)
  })

  it('page.tsx importa e usa <PrintButton /> em vez do <button onClick> inline antigo', () => {
    expect(PAGE_CODE_ONLY).toMatch(/import\s*\{\s*PrintButton\s*\}\s*from\s*['"]\.\/PrintButton['"]/)
    expect(PAGE_CODE_ONLY).toMatch(/<PrintButton\s*\/>/)
  })

  it('PrintButton.tsx é Client Component ("use client") e concentra o onClick', () => {
    expect(PRINT_BUTTON_SOURCE.trimStart().startsWith("'use client'")).toBe(true)
    expect(PRINT_BUTTON_SOURCE).toMatch(/onClick=\{.*window\.print\(\).*\}/)
  })

  it('PrintTrigger.tsx continua sendo Client Component (auto-print ao abrir)', () => {
    expect(PRINT_TRIGGER_SOURCE.trimStart().startsWith("'use client'")).toBe(true)
  })
})
