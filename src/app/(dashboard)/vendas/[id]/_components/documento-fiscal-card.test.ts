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
    expect(SOURCE).toMatch(/resolveFocusResourceUrl\(\{ path: result\?\.danfePath, environment: resultEnvironment \}\)/)
    expect(SOURCE).toMatch(/resolveFocusResourceUrl\(\{ path: result\?\.xmlPath, environment: resultEnvironment \}\)/)
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

  it('aviso de homologação é condicionado ao ambiente REAL (resultEnvironment) — nunca um texto fixo incondicional (achado real, auditoria pré-go-live 2026-08-28: o card mostrava isso sempre, mesmo com a empresa em produção)', () => {
    expect(SOURCE).toMatch(/resultEnvironment !== 'producao' && \(/)
    expect(SOURCE).toMatch(/AMBIENTE DE HOMOLOGAÇÃO — SEM VALIDADE FISCAL/)
    // O card (DocumentoFiscalCard) não pode mais renderizar o aviso
    // incondicionalmente antes de saber o resolvedType/documentos — só
    // DocumentTypeSection (que tem resultEnvironment) pode.
    const cardFn = SOURCE.slice(SOURCE.indexOf('export function DocumentoFiscalCard'))
    expect(cardFn).not.toMatch(/AMBIENTE DE HOMOLOGAÇÃO/)
  })
})

describe('DocumentoFiscalCard — simplificação da arquitetura de impressão (DANFE da Focus é o destino PRINCIPAL, DANFE local vira fallback/debug)', () => {
  it('"Abrir DANFE (Focus)" aparece ANTES de "DANFE local (fallback/debug)" no JSX — Focus é a ação primária', () => {
    const focusIdx = SOURCE.indexOf('Abrir DANFE (Focus)')
    const localIdx = SOURCE.indexOf('DANFE local (fallback/debug)')
    expect(focusIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeGreaterThan(-1)
    expect(focusIdx).toBeLessThan(localIdx)
  })

  it('link local do DANFE NFC-e é visualmente secundário (texto menor/mudo), nunca no mesmo destaque do link da Focus', () => {
    const localLinkBlock = SOURCE.slice(SOURCE.indexOf('DANFE local (fallback/debug)') - 300, SOURCE.indexOf('DANFE local (fallback/debug)'))
    expect(localLinkBlock).toMatch(/text-text-muted/)
  })

  it('autorizado sem danfe_path válido → mensagem de erro explícita, nunca fica em silêncio (item "retornar estado/erro explícito")', () => {
    expect(SOURCE).toMatch(/DANFE da Focus indisponível \(danfe_path ausente\/inválido\)/)
  })

  it('EnvironmentBadge é exportado (reaproveitado em vendas\\/\\[id\\]\\/page.tsx pro botão principal de impressão)', () => {
    expect(SOURCE).toMatch(/export function EnvironmentBadge/)
  })
})

describe('DocumentoFiscalCard — environment é sempre real, nunca um literal fixo (achado real, pré-produção)', () => {
  it('nenhuma chamada a resolveFocusResourceUrl usa fallback "?? \'homologacao\'" — o ambiente vem sempre de resultEnvironment/environment real', () => {
    expect(SOURCE).not.toMatch(/resultEnvironment \?\? 'homologacao'/)
    expect(SOURCE).not.toMatch(/environment: 'homologacao'/)
  })

  it('resultEnvironment é inicializado com o ambiente REAL do documento (initial.environment) ou a config atual da empresa (currentEnvironment) — nunca null/literal', () => {
    expect(SOURCE).toMatch(/useState<FocusEnvironment>\(initial\?\.environment \?\? currentEnvironment\)/)
  })

  it('após emissão/consulta, resultEnvironment é atualizado com o environment REAL devolvido pela API (SubmitNfeResult.environment) — currentEnvironment só como último recurso', () => {
    expect(SOURCE).toMatch(/setResultEnvironment\(freshResult\?\.environment \?\? currentEnvironment\)/)
  })
})
