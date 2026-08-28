// Regressão (auditoria pós-autorização, venda 703, 2026-09-06 — BUG 2:
// "DANFE (Focus)"/"XML" resolviam contra o host do ERP em vez da Focus).
// Sem jsdom/Testing Library neste repo — inspeção de código-fonte é o
// padrão já usado em comprovante/page.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'documento-fiscal-card.tsx'), 'utf-8')

describe('DocumentoFiscalCard — links Focus nunca usam caminho relativo cru como href (item 4/8 dos testes obrigatórios)', () => {
  it('usa resolveFocusResourceUrl pra DANFE (Focus) e XML — nunca href={result.danfePath}/href={result.xmlPath} direto', () => {
    expect(SOURCE).toMatch(/import \{ resolveFocusResourceUrl \} from '@\/lib\/fiscal\/resolveFocusResourceUrl'/)
    expect(SOURCE).toMatch(/resolveFocusResourceUrl\(\{ path: result\?\.danfePath, environment: resultEnvironment \?\? 'homologacao' \}\)/)
    expect(SOURCE).toMatch(/resolveFocusResourceUrl\(\{ path: result\?\.xmlPath, environment: resultEnvironment \?\? 'homologacao' \}\)/)
    // Fora de comentários (a linha que documenta o bug histórico menciona
    // esse padrão de propósito) — nunca deve existir como JSX de verdade.
    const codeOnly = SOURCE.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    expect(codeOnly).not.toMatch(/href=\{result\.danfePath\}/)
    expect(codeOnly).not.toMatch(/href=\{result\.xmlPath\}/)
  })

  it('nunca hardcoda o host do ERP nem monta URL Focus manualmente', () => {
    expect(SOURCE).not.toMatch(/santtorini\.qarvon\.com/)
    expect(SOURCE).not.toMatch(/`\$\{result\.danfePath\}`|`\$\{result\.xmlPath\}`/)
  })

  it('nunca referencia token Focus (emissão/consulta passam só por rotas backend próprias)', () => {
    expect(SOURCE).not.toMatch(/\btoken\b/i)
  })

  it('mostra badge de ambiente (Homologação/Produção) junto do status "Autorizada" — nunca "Autorizada" sozinho', () => {
    expect(SOURCE).toMatch(/function EnvironmentBadge/)
    expect(SOURCE).toMatch(/result\.status === 'authorized' && resultEnvironment && <EnvironmentBadge/)
  })

  it('continua mostrando o aviso geral de homologação no topo do card', () => {
    expect(SOURCE).toMatch(/AMBIENTE DE HOMOLOGAÇÃO — SEM VALIDADE FISCAL/)
  })
})
