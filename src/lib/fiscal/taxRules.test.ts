import { describe, it, expect } from 'vitest'
import { resolveCfop, resolveIcmsCsosn, resolvePisCofinsCst, resolveIpiTreatment, resolveIbsCbsTestYear2026, FiscalRuleNotImplementedError } from './taxRules'

describe('resolveCfop', () => {
  it('MEI (CRT 4), venda RN → RN → 5102', () => {
    expect(resolveCfop({ originUf: 'RN', destinationUf: 'RN', crt: 4 })).toBe('5102')
  })

  it('MEI (CRT 4), venda RN → outro estado (SP) → 6102, NUNCA 6108 (rejeição SEFAZ 337 pra CRT=4/CSOSN 102)', () => {
    expect(resolveCfop({ originUf: 'RN', destinationUf: 'SP', crt: 4 })).toBe('6102')
  })

  it('Simples Nacional normal (CRT 1, futuro pós-desenquadramento), venda RN → RN → 5102', () => {
    expect(resolveCfop({ originUf: 'RN', destinationUf: 'RN', crt: 1 })).toBe('5102')
  })

  it('Simples Nacional normal (CRT 1), venda interestadual a consumidor final não contribuinte → 6108 (regra geral, sem a restrição de MEI)', () => {
    expect(resolveCfop({ originUf: 'RN', destinationUf: 'SP', crt: 1 })).toBe('6108')
  })

  it('comparação de UF é case-insensitive e tolera espaços', () => {
    expect(resolveCfop({ originUf: ' rn ', destinationUf: 'RN', crt: 4 })).toBe('5102')
  })

  it('CRT 2 (excesso de sublimite) não tem regra implementada — lança, não inventa', () => {
    expect(() => resolveCfop({ originUf: 'RN', destinationUf: 'RN', crt: 2 })).toThrow(FiscalRuleNotImplementedError)
  })

  it('CRT 3 (Regime Normal) não tem regra implementada — lança, não inventa', () => {
    expect(() => resolveCfop({ originUf: 'RN', destinationUf: 'RN', crt: 3 })).toThrow(FiscalRuleNotImplementedError)
  })
})

describe('resolveIcmsCsosn', () => {
  it('CRT 4 (MEI) → CSOSN 102 (revenda simples, dentro da lista permitida {102,300,400,900} pra CRT=4)', () => {
    expect(resolveIcmsCsosn(4)).toBe('102')
  })

  it('CRT 1 (Simples Nacional) → CSOSN 102', () => {
    expect(resolveIcmsCsosn(1)).toBe('102')
  })

  it('CRT 2/3 não implementado', () => {
    expect(() => resolveIcmsCsosn(2)).toThrow(FiscalRuleNotImplementedError)
    expect(() => resolveIcmsCsosn(3)).toThrow(FiscalRuleNotImplementedError)
  })
})

describe('resolvePisCofinsCst', () => {
  it('CRT 1 e CRT 4 → CST 49 (convenção Simples Nacional/MEI — tributo via DAS)', () => {
    expect(resolvePisCofinsCst(4)).toEqual({ cst: '49' })
    expect(resolvePisCofinsCst(1)).toEqual({ cst: '49' })
  })

  it('CRT 2/3 não implementado', () => {
    expect(() => resolvePisCofinsCst(2)).toThrow(FiscalRuleNotImplementedError)
  })
})

describe('resolveIpiTreatment', () => {
  it('não varia por CRT — CST 53 + código de enquadramento legal 999 (não aplicável, confirmado na doc Focus)', () => {
    expect(resolveIpiTreatment()).toEqual({ cst: '53', codigoEnquadramentoLegal: '999' })
  })
})

describe('resolveIbsCbsTestYear2026 — confirmado empiricamente por 2 XMLs reais autorizados (Fase 2B)', () => {
  it('CST 000 (tributação integral) + cClassTrib 000001', () => {
    const result = resolveIbsCbsTestYear2026()
    expect(result.situacaoTributaria).toBe('000')
    expect(result.classificacaoTributaria).toBe('000001')
  })

  it('base de cálculo zero no ano-teste, mesmo com item de valor não nulo (reproduz o XML real, não computa a partir do preço)', () => {
    expect(resolveIbsCbsTestYear2026().baseCalculo).toBe(0)
  })

  it('alíquotas do ano-teste: IBS-UF 0.10%, IBS-Município 0%, CBS 0.90% — exatamente como observado nos dois XMLs', () => {
    const result = resolveIbsCbsTestYear2026()
    expect(result.aliquotaIbsUf).toBe(0.1)
    expect(result.aliquotaIbsMunicipio).toBe(0)
    expect(result.aliquotaCbs).toBe(0.9)
  })

  it('não depende do CRT — reforma tributária se aplica uniformemente (MEI e Simples Nacional normal)', () => {
    // resolveIbsCbsTestYear2026 não recebe CRT como parâmetro — a própria
    // assinatura da função já garante isso; este teste documenta a decisão.
    expect(resolveIbsCbsTestYear2026).toHaveLength(0)
  })
})
