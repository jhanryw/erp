import { describe, it, expect } from 'vitest'
import { resolvePostSalePrintTarget } from './resolvePostSalePrintTarget'

const SALE_ID = 42

describe('resolvePostSalePrintTarget', () => {
  it('1) NFC-e HOMOLOGAÇÃO autorizada + auto_print → abre o DANFE oficial da Focus no host de HOMOLOGAÇÃO (nunca mais /vendas/[id]/nfce)', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: 'https://homologacao.focusnfe.com.br/notas_fiscais_consumidor/NFe123.html', reason: 'fiscal_authorized' })
  })

  it('2) NFC-e PRODUÇÃO autorizada + auto_print → abre o DANFE oficial da Focus no host de PRODUÇÃO', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: 'producao' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: 'https://api.focusnfe.com.br/notas_fiscais_consumidor/NFe123.html', reason: 'fiscal_authorized' })
  })

  it('3) NF-e HOMOLOGAÇÃO autorizada + auto_print → mesma regra de NFC-e, host de HOMOLOGAÇÃO', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfe', danfePath: '/arquivos/empresa/XMLs/NFe456.pdf', environment: 'homologacao' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: 'https://homologacao.focusnfe.com.br/arquivos/empresa/XMLs/NFe456.pdf', reason: 'fiscal_authorized' })
  })

  it('4) NF-e PRODUÇÃO autorizada + auto_print → host de PRODUÇÃO', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfe', danfePath: '/arquivos/empresa/XMLs/NFe456.pdf', environment: 'producao' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false },
    })
    expect(result).toEqual({ url: 'https://api.focusnfe.com.br/arquivos/empresa/XMLs/NFe456.pdf', reason: 'fiscal_authorized' })
  })

  it('5) NENHUM literal "homologacao" controla a resolução — ambiente vem exclusivamente de fiscal.environment (mesmo danfe_path, ambientes diferentes → hosts diferentes)', () => {
    const base = { status: 'authorized' as const, requested: 'nfce' as const, danfePath: '/mesmo/caminho.html' }
    const hom = resolvePostSalePrintTarget({ saleId: SALE_ID, fiscal: { ...base, environment: 'homologacao' }, fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false } })
    const prod = resolvePostSalePrintTarget({ saleId: SALE_ID, fiscal: { ...base, environment: 'producao' }, fiscalPrint: { autoPrint: true, printNonFiscalReceipt: false } })
    expect(hom.url).toBe('https://homologacao.focusnfe.com.br/mesmo/caminho.html')
    expect(prod.url).toBe('https://api.focusnfe.com.br/mesmo/caminho.html')
    expect(hom.url).not.toBe(prod.url) // prova que o environment de ENTRADA, não um literal fixo, decide o host
  })

  it('REGRA CENTRAL: documento fiscal autorizado vence mesmo se a policy (inconsistente) também mandar imprimir o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' },
      // policy nunca deveria existir assim (bloqueado por validação na origem),
      // mas o runtime nunca pode confiar cegamente nisso.
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result.reason).toBe('fiscal_authorized')
    expect(result.url).not.toContain('/comprovante')
  })

  it('6a) documento autorizado SEM danfe_path (Focus ainda não persistiu) → estado explícito, NUNCA cai silenciosamente pro comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: null, environment: 'homologacao' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'fiscal_authorized_missing_danfe' })
  })

  it('6b) documento autorizado SEM environment (não deveria acontecer, mas nunca assume homologação por suposição) → mesmo estado explícito', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: null },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'fiscal_authorized_missing_danfe' })
  })

  it('documento autorizado com danfe_path/environment AUSENTES do objeto (nunca undefined vira "cai pro comprovante") → mesmo estado explícito', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfe' },
      fiscalPrint: { autoPrint: true, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'fiscal_authorized_missing_danfe' })
  })

  it('NFC-e autorizada mesmo com print_non_fiscal_receipt=true (policy antiga/inconsistente) → nunca imprime o comprovante', () => {
    const result = resolvePostSalePrintTarget({
      saleId: SALE_ID,
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'none' })
  })

  it('7) sem tentativa de emissão (fiscal ausente) + policy manda comprovante → imprime o comprovante não fiscal', () => {
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
      fiscal: { status: 'authorized', requested: 'nfce', danfePath: '/notas_fiscais_consumidor/NFe123.html', environment: 'homologacao' },
      fiscalPrint: { autoPrint: false, printNonFiscalReceipt: true },
    })
    expect(result).toEqual({ url: null, reason: 'none' })
  })

  it('fiscalPrint ausente (fail-safe) + nenhuma emissão tentada → assume comprovante (comportamento antigo preservado)', () => {
    const result = resolvePostSalePrintTarget({ saleId: SALE_ID, fiscal: undefined, fiscalPrint: undefined })
    expect(result).toEqual({ url: `/vendas/${SALE_ID}/comprovante`, reason: 'non_fiscal_receipt' })
  })
})
