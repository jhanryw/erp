import { describe, it, expect } from 'vitest'
import { resolveFiscalOperationDecision, type FiscalOperationPolicy } from './resolveFiscalOperationDecision'

function policy(overrides: Partial<FiscalOperationPolicy> = {}): FiscalOperationPolicy {
  return {
    fiscalEnabled: true,
    documentMode: 'auto',
    autoIssue: true,
    autoPrint: true,
    printNonFiscalReceipt: false,
    manualIssueAllowed: true,
    ...overrides,
  }
}

describe('resolveFiscalOperationDecision — fallback seguro (seção 38)', () => {
  it('operationType=null → configuration_missing, nunca emite por suposição', () => {
    const d = resolveFiscalOperationDecision({ operationType: null, policy: null, operatorChoice: 'auto', deliveryMode: 'pickup', saleOrigin: 'store' })
    expect(d.status).toBe('configuration_missing')
    expect(d.attempt).toBeNull()
    expect(d.reason).toBeTruthy()
  })

  it('policy=null (nenhuma linha configurada) → configuration_missing, nunca emite por suposição', () => {
    const d = resolveFiscalOperationDecision({ operationType: 'pos_retail', policy: null, operatorChoice: 'auto', deliveryMode: null, saleOrigin: 'store' })
    expect(d.status).toBe('configuration_missing')
    expect(d.attempt).toBeNull()
    expect(d.reason).toMatch(/pos_retail/)
  })
})

describe('resolveFiscalOperationDecision — fiscal_enabled=false', () => {
  it('nunca emite, mas preserva printNonFiscalReceipt/manualIssueAllowed da policy (seção 10)', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'wholesale',
      policy: policy({ fiscalEnabled: false, printNonFiscalReceipt: true, manualIssueAllowed: true }),
      operatorChoice: 'auto', deliveryMode: null, saleOrigin: 'store',
    })
    expect(d.status).toBe('fiscal_disabled')
    expect(d.attempt).toBeNull()
    expect(d.printNonFiscalReceipt).toBe(true)
    expect(d.manualIssueAllowed).toBe(true)
    expect(d.autoPrint).toBe(false)
  })
})

describe('resolveFiscalOperationDecision — operatorChoice=none (override explícito, silencioso)', () => {
  it('nunca emite e nunca reporta motivo, mesmo numa operação elegível e com fiscal ativo', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail', policy: policy(), operatorChoice: 'none', deliveryMode: 'pickup', saleOrigin: 'store',
    })
    expect(d).toEqual({
      operationType: 'pos_retail', attempt: null, status: 'skipped_by_operator', reason: null,
      autoPrint: false, printNonFiscalReceipt: false, manualIssueAllowed: true,
    })
  })
})

describe('resolveFiscalOperationDecision — Empresa A: pos_retail/nfce/auto_issue=true/auto_print=true', () => {
  it('emite NFC-e automaticamente com impressão automática', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail',
      policy: policy({ documentMode: 'nfce', autoIssue: true, autoPrint: true, printNonFiscalReceipt: false }),
      operatorChoice: 'auto', deliveryMode: 'pickup', saleOrigin: 'store',
    })
    expect(d.status).toBe('emission_pending')
    expect(d.attempt).toBe('nfce')
    expect(d.autoPrint).toBe(true)
    expect(d.printNonFiscalReceipt).toBe(false)
  })
})

describe('resolveFiscalOperationDecision — Empresa B: pos_retail/nfce/auto_issue=true/auto_print=false', () => {
  it('emite NFC-e automaticamente SEM impressão automática', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail',
      policy: policy({ documentMode: 'nfce', autoIssue: true, autoPrint: false }),
      operatorChoice: 'auto', deliveryMode: 'pickup', saleOrigin: 'store',
    })
    expect(d.status).toBe('emission_pending')
    expect(d.attempt).toBe('nfce')
    expect(d.autoPrint).toBe(false)
  })
})

describe('resolveFiscalOperationDecision — Empresa C: pos_retail/nfe/auto_issue=false', () => {
  it('não transmite automaticamente — manual_issue_required', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail',
      policy: policy({ documentMode: 'nfe', autoIssue: false }),
      operatorChoice: 'auto', deliveryMode: 'delivery', saleOrigin: 'store',
    })
    expect(d.status).toBe('manual_issue_required')
    expect(d.attempt).toBeNull()
  })
})

describe('resolveFiscalOperationDecision — document_mode=auto → resolver legal decide', () => {
  it('balcão/retirada (pickup) → nfce', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_pickup', policy: policy({ documentMode: 'auto' }), operatorChoice: 'auto', deliveryMode: 'pickup', saleOrigin: 'store',
    })
    expect(d.attempt).toBe('nfce')
  })

  it('entrega (delivery) → nfe', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_delivery', policy: policy({ documentMode: 'auto' }), operatorChoice: 'auto', deliveryMode: 'delivery', saleOrigin: 'store',
    })
    expect(d.attempt).toBe('nfe')
  })

  it('dado ambíguo (resolver legal = blocked) → eligibility_blocked, nunca emite', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'manual', policy: policy({ documentMode: 'auto' }), operatorChoice: 'auto', deliveryMode: null, saleOrigin: 'instagram',
    })
    expect(d.status).toBe('eligibility_blocked')
    expect(d.attempt).toBeNull()
    expect(d.reason).toBeTruthy()
  })
})

describe('resolveFiscalOperationDecision — policy pede NFC-e mas operação concreta não permite (seção 3, configuração NUNCA sobrepõe legislação)', () => {
  it('document_mode=nfce numa venda de entrega (resolve pra nfe) → eligibility_blocked, NUNCA emite nfce nem troca silenciosamente pra nfe', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'wholesale',
      policy: policy({ documentMode: 'nfce', autoIssue: true }),
      operatorChoice: 'auto', deliveryMode: 'delivery', saleOrigin: 'store',
    })
    expect(d.status).toBe('eligibility_blocked')
    expect(d.attempt).toBeNull()
    expect(d.reason).toMatch(/NF-e/)
  })

  it('document_mode=nfe é sempre permitido (NF-e nunca tem gate de elegibilidade)', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail', policy: policy({ documentMode: 'nfe', autoIssue: true }), operatorChoice: 'auto', deliveryMode: 'pickup', saleOrigin: 'store',
    })
    expect(d.attempt).toBe('nfe')
    expect(d.status).toBe('emission_pending')
  })
})

describe('resolveFiscalOperationDecision — document_mode=none', () => {
  it('nunca tenta emitir automaticamente, mesmo com fiscal_enabled=true e auto_issue=true', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'manual', policy: policy({ documentMode: 'none', autoIssue: true }), operatorChoice: 'auto', deliveryMode: null, saleOrigin: 'other',
    })
    expect(d.attempt).toBeNull()
    expect(d.status).toBe('manual_issue_required')
  })
})

describe('resolveFiscalOperationDecision — override manual do operador (nfce/nfe explícito)', () => {
  it('manual_issue_allowed=false bloqueia QUALQUER override explícito', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_retail', policy: policy({ manualIssueAllowed: false }), operatorChoice: 'nfe', deliveryMode: 'delivery', saleOrigin: 'store',
    })
    expect(d.status).toBe('manual_issue_required')
    expect(d.attempt).toBeNull()
  })

  it('operador pede nfce numa venda que resolve pra nfe → bloqueado, nunca troca de tipo', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'pos_delivery', policy: policy(), operatorChoice: 'nfce', deliveryMode: 'delivery', saleOrigin: 'store',
    })
    expect(d.status).toBe('eligibility_blocked')
    expect(d.attempt).toBeNull()
  })

  it('operador pede nfe explicitamente numa venda de atacado (document_mode=nfe, auto_issue=false) → emite mesmo assim (override manual funciona independente de auto_issue)', () => {
    const d = resolveFiscalOperationDecision({
      operationType: 'wholesale', policy: policy({ documentMode: 'nfe', autoIssue: false, manualIssueAllowed: true }), operatorChoice: 'nfe', deliveryMode: null, saleOrigin: 'store',
    })
    expect(d.status).toBe('emission_pending')
    expect(d.attempt).toBe('nfe')
  })
})

describe('resolveFiscalOperationDecision — multiempresa: nenhuma policy vaza (prova por construção)', () => {
  it('a mesma operação e os mesmos dados de venda produzem resultados DIFERENTES conforme a policy passada — nunca hardcoded', () => {
    const base = { operationType: 'pos_retail' as const, operatorChoice: 'auto' as const, deliveryMode: 'pickup', saleOrigin: 'store' }
    const empresaA = resolveFiscalOperationDecision({ ...base, policy: policy({ documentMode: 'nfce', autoIssue: true }) })
    const empresaB = resolveFiscalOperationDecision({ ...base, policy: policy({ documentMode: 'nfce', autoIssue: false }) })
    const empresaC = resolveFiscalOperationDecision({ ...base, policy: policy({ fiscalEnabled: false }) })
    expect(empresaA.attempt).toBe('nfce')
    expect(empresaB.attempt).toBeNull()
    expect(empresaB.status).toBe('manual_issue_required')
    expect(empresaC.status).toBe('fiscal_disabled')
  })
})
