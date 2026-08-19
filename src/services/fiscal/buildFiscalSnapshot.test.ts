import { describe, it, expect } from 'vitest'
import { buildFiscalDocumentSnapshot } from './buildFiscalSnapshot'
import { FiscalBuildError } from './buildNfePayload'
import { baseFiscalContext } from './testFixtures'

describe('buildFiscalDocumentSnapshot', () => {
  it('header reflete exatamente o formato de fiscal_documents (draft, focus_nfe, nfe)', () => {
    const snapshot = buildFiscalDocumentSnapshot(baseFiscalContext())
    expect(snapshot.header).toEqual({
      company_id: 1,
      sale_id: 9001,
      document_type: 'nfe',
      provider: 'focus_nfe',
      environment: 'homologacao',
      provider_ref: 'teste-preview-ref-0001',
      status: 'draft',
    })
  })

  it('item snapshot inclui CFOP/CSOSN resolvidos e tax_details com PIS/COFINS/IPI', () => {
    const snapshot = buildFiscalDocumentSnapshot(baseFiscalContext())
    const item = snapshot.items[0]
    expect(item.cfop).toBe('6102')
    expect(item.csosn_cst).toBe('102')
    expect(item.tax_details).toEqual({
      icms_origem: 2,
      pis_cst: '49',
      cofins_cst: '49',
      ipi_cst: '53',
      ipi_codigo_enquadramento_legal: '999',
      ibs_cbs_situacao_tributaria: '000',
      ibs_cbs_classificacao_tributaria: '000001',
      ibs_uf_aliquota: 0.1,
      ibs_mun_aliquota: 0,
      cbs_aliquota: 0.9,
      ibs_valor_total: 0,
      cbs_valor: 0,
    })
  })

  it('total_amount = unit_price × quantity − discount_amount', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], unitPrice: 50, quantity: 3, discountAmount: 10 }] })
    const snapshot = buildFiscalDocumentSnapshot(ctx)
    expect(snapshot.items[0].total_amount).toBe(140)
  })

  it('snapshot é imutável em relação à origem: alterar o objeto de contexto depois de montar o snapshot não muda o snapshot já produzido', () => {
    const ctx = baseFiscalContext()
    const snapshot = buildFiscalDocumentSnapshot(ctx)
    const originalCfop = snapshot.items[0].cfop

    // Mutação do contexto original (simulando o dado de origem mudando depois) —
    // não deve refletir no snapshot já construído, porque o snapshot é um
    // novo objeto, não uma referência viva ao contexto.
    ;(ctx.items[0] as any).ncm = '99999999'
    ctx.emitente.uf = 'SP'

    expect(snapshot.items[0].cfop).toBe(originalCfop)
    expect(snapshot.items[0].ncm).toBe('61082200')
  })

  it('duas chamadas com o mesmo contexto produzem snapshots iguais em valor, mas são objetos distintos (nunca a mesma referência)', () => {
    const ctx = baseFiscalContext()
    const snapshot1 = buildFiscalDocumentSnapshot(ctx)
    const snapshot2 = buildFiscalDocumentSnapshot(ctx)

    expect(snapshot1).toEqual(snapshot2)
    expect(snapshot1).not.toBe(snapshot2)
    expect(snapshot1.items[0]).not.toBe(snapshot2.items[0])
  })

  it('CEST null é preservado como null (não confundido com ausência de dado obrigatório)', () => {
    const snapshot = buildFiscalDocumentSnapshot(baseFiscalContext())
    expect(snapshot.items[0].cest).toBeNull()
  })

  it('NCM ausente → lança FiscalBuildError, nunca gera snapshot parcial', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: null }] })
    expect(() => buildFiscalDocumentSnapshot(ctx)).toThrow(FiscalBuildError)
  })
})
