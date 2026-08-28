import { describe, it, expect } from 'vitest'
import { resolvePostSalePrintTarget } from './resolvePostSalePrintTarget'

const SALE_ID = 42

describe('resolvePostSalePrintTarget', () => {
  it('NFC-e autorizada + auto_print → abre o DANFE NFC-e, nunca o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: `/vendas/${SALE_ID}/nfce`, reason: 'fiscal_authorized' })
  })

  it('REGRA CENTRAL: documento fiscal autorizado vence mesmo se a policy (inconsistente) também mandar imprimir o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce' },
      // policy nunca deveria existir assim (bloqueado por validação na origem),
      // mas o runtime nunca pode confiar cegamente nisso.
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result.url).toBe(`/vendas/${SALE_ID}/nfce`)
    expect(result.reason).toBe('fiscal_authorized')
  })

  it('NF-e autorizada → nunca auto-abre nada localmente (não existe DANFE NF-e local nesta fase), e NUNCA cai pro comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfe' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: null, reason: 'none' })
  })

  it('NF-e autorizada mesmo com print_non_fiscal_receipt=true (policy antiga/inconsistente) → nunca imprime o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfe' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: true },
    })
    expect(result.url).toBeNull()
    expect(result.reason).toBe('none')
  })

  it('sem tentativa de emissão (fiscal ausente) + policy manda comprovante → imprime o comprovante não fiscal', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: undefined,
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: `/vendas/${SALE_ID}/comprovante`, reason: 'non_fiscal_receipt' })
  })

  it('emissão pendente (ainda não autorizada) + policy manda comprovante → imprime o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'pending', requested: 'nfce' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: `/vendas/${SALE_ID}/comprovante`, reason: 'non_fiscal_receipt' })
  })

  it('emissão com erro + policy não manda comprovante → nada a imprimir', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'error', requested: 'nfe' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: null, reason: 'none' })
  })

  it('NFC-e autorizada mas auto_print=false → não auto-abre o DANFE, e como fiscalJustAuthorized é true, também não abre o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'none' })
  })

  it('fiscalPrint ausente (fail-safe) + nenhuma emissão tentada → assume comprovante (comportamento antigo preservado)', () => {
    const result = resolvePostSalePrintTarget({ saleId: SALE_ID, fiscal: undefined, fiscalPrint: undefined })
    expect(result).toEqual({ url: `/vendas/${SALE_ID}/comprovante`, reason: 'non_fiscal_receipt' })
  })
})
