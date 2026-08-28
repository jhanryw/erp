// Regressão — auditoria de acesso fiscal: a liberação de operação fiscal
// de VENDA (emitir/consultar/DANFE/XML) nunca deve se estender a
// configuração fiscal/credenciais. Este arquivo prova, por inspeção de
// código-fonte, que as rotas de configuração/secrets continuam
// exigindo requireRole('admin') — nenhuma delas foi tocada nesta
// liberação.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf-8')
}

describe('rotas de configuração/credenciais fiscais continuam admin-only', () => {
  it('/api/fiscal/empresa (cadastro da empresa na Focus) — admin-only', () => {
    expect(source('src/app/api/fiscal/empresa/route.ts')).toMatch(/requireRole\('admin'\)/)
  })

  it('/api/fiscal/health (status/checklist de configuração) — admin-only', () => {
    const src = source('src/app/api/fiscal/health/route.ts')
    expect(src).toMatch(/requireRole\('admin'\)/)
    expect(src).not.toMatch(/requireRole\('usuario'\)/)
  })

  it('/api/fiscal/nfe/preview (payload bruto de diagnóstico) — admin-only', () => {
    expect(source('src/app/api/fiscal/nfe/preview/route.ts')).toMatch(/requireRole\('admin'\)/)
  })

  it('/api/configuracoes/fiscal/csc (CSC) — admin-only', () => {
    const src = source('src/app/api/configuracoes/fiscal/csc/route.ts')
    expect(src.match(/requireRole\('admin'\)/g)?.length).toBe(2) // GET e PUT
  })

  it('/api/configuracoes/fiscal/focus-tokens (tokens de emissão/master) — admin-only', () => {
    const src = source('src/app/api/configuracoes/fiscal/focus-tokens/route.ts')
    expect(src.match(/requireRole\('admin'\)/g)?.length).toBe(2) // GET e PUT
  })
})

describe('rotas de OPERAÇÃO fiscal de venda — liberadas pra qualquer usuário autenticado', () => {
  it('/api/fiscal/nfce/emitir-homologacao — requireRole(\'usuario\'), nunca mais admin', () => {
    const src = source('src/app/api/fiscal/nfce/emitir-homologacao/route.ts')
    expect(src).toMatch(/requireRole\('usuario'\)/)
    expect(src).not.toMatch(/requireRole\('admin'\)/)
  })

  it('/api/fiscal/nfce/consultar — requireRole(\'usuario\'), nunca mais admin', () => {
    const src = source('src/app/api/fiscal/nfce/consultar/route.ts')
    expect(src).toMatch(/requireRole\('usuario'\)/)
    expect(src).not.toMatch(/requireRole\('admin'\)/)
  })

  it('/api/fiscal/nfe/emitir-homologacao — requireRole(\'usuario\'), nunca mais admin', () => {
    const src = source('src/app/api/fiscal/nfe/emitir-homologacao/route.ts')
    expect(src).toMatch(/requireRole\('usuario'\)/)
    expect(src).not.toMatch(/requireRole\('admin'\)/)
  })

  it('/api/fiscal/nfe/consultar — requireRole(\'usuario\'), nunca mais admin', () => {
    const src = source('src/app/api/fiscal/nfe/consultar/route.ts')
    expect(src).toMatch(/requireRole\('usuario'\)/)
    expect(src).not.toMatch(/requireRole\('admin'\)/)
  })

  it('/api/fiscal/recipient — requireRole(\'usuario\') nos dois handlers, nunca mais admin', () => {
    const src = source('src/app/api/fiscal/recipient/route.ts')
    expect(src.match(/requireRole\('usuario'\)/g)?.length).toBe(2) // GET e POST
    expect(src).not.toMatch(/requireRole\('admin'\)/)
  })

  it('/vendas/[id]/nfce (DANFE local) — já era requirePageRole(\'usuario\'), continua assim', () => {
    const src = source('src/app/(print)/vendas/[id]/nfce/page.tsx')
    expect(src).toMatch(/requirePageRole\('usuario'\)/)
  })
})
