import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeFiscalPolicy } from './executeFiscalPolicy'
import { submitNfceHomologacao } from './submitNfceHomologacao'
import { submitNfeHomologacao } from './submitNfeHomologacao'
import type { FiscalOperationDecision } from '@/lib/fiscal/resolveFiscalOperationDecision'

vi.mock('./submitNfceHomologacao', () => ({ submitNfceHomologacao: vi.fn() }))
vi.mock('./submitNfeHomologacao', () => ({ submitNfeHomologacao: vi.fn() }))
vi.mock('./upsertSaleRecipient', () => ({ upsertSaleRecipient: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

function decision(overrides: Partial<FiscalOperationDecision> = {}): FiscalOperationDecision {
  return {
    operationType: 'retail_pickup', attempt: null, status: 'fiscal_disabled', reason: null,
    autoPrint: false, printNonFiscalReceipt: true, manualIssueAllowed: true,
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('executeFiscalPolicy — decision.attempt define QUAL emissão chamar', () => {
  it('attempt=nfce → chama submitNfceHomologacao, nunca submitNfeHomologacao', async () => {
    ;(submitNfceHomologacao as any).mockResolvedValue({ ok: true, data: { status: 'authorized', fiscalDocumentId: 501, validationErrors: [] } })
    const result = await executeFiscalPolicy({ saleId: 1, companyId: 1, decision: decision({ attempt: 'nfce', status: 'emission_pending' }) })
    expect(submitNfceHomologacao).toHaveBeenCalledWith(1, 1)
    expect(submitNfeHomologacao).not.toHaveBeenCalled()
    expect(result.fiscalResult).toEqual({ requested: 'nfce', status: 'authorized', reason: null, fiscal_document_id: 501, validation_errors: [] })
  })

  it('attempt=nfe → chama submitNfeHomologacao, nunca submitNfceHomologacao', async () => {
    ;(submitNfeHomologacao as any).mockResolvedValue({ ok: true, data: { status: 'pending', fiscalDocumentId: 502, validationErrors: [] } })
    const result = await executeFiscalPolicy({ saleId: 2, companyId: 1, decision: decision({ attempt: 'nfe', status: 'emission_pending' }) })
    expect(submitNfeHomologacao).toHaveBeenCalledWith(2, 1)
    expect(submitNfceHomologacao).not.toHaveBeenCalled()
    expect(result.fiscalResult?.status).toBe('pending')
  })

  it('emissão falha (ok:false) → status error com o motivo da Focus, nunca lança', async () => {
    ;(submitNfceHomologacao as any).mockResolvedValue({ ok: false, error: 'Focus indisponível' })
    const result = await executeFiscalPolicy({ saleId: 3, companyId: 1, decision: decision({ attempt: 'nfce', status: 'emission_pending' }) })
    expect(result.fiscalResult).toEqual({ requested: 'nfce', status: 'error', reason: 'Focus indisponível', fiscal_document_id: null, validation_errors: [] })
  })

  it('emissão lança exceção → capturada, status error, nunca propaga (venda já foi criada)', async () => {
    ;(submitNfceHomologacao as any).mockRejectedValue(new Error('timeout de rede'))
    const result = await executeFiscalPolicy({ saleId: 4, companyId: 1, decision: decision({ attempt: 'nfce', status: 'emission_pending' }) })
    expect(result.fiscalResult?.status).toBe('error')
  })
})

describe('executeFiscalPolicy — attempt=null (nada a emitir)', () => {
  it('com reason (bloqueio/configuração) → reporta o motivo, nunca chama emissão', async () => {
    const result = await executeFiscalPolicy({
      saleId: 5, companyId: 1,
      decision: decision({ attempt: null, status: 'eligibility_blocked', reason: 'Esta venda não é elegível para NFC-e.' }),
    })
    expect(submitNfceHomologacao).not.toHaveBeenCalled()
    expect(submitNfeHomologacao).not.toHaveBeenCalled()
    expect(result.fiscalResult).toEqual({ requested: 'nfce', status: 'eligibility_blocked', reason: 'Esta venda não é elegível para NFC-e.', fiscal_document_id: null, validation_errors: [] })
  })

  it('sem reason (fiscal_disabled ou skipped_by_operator) → fiscalResult null, silêncio total', async () => {
    const disabled = await executeFiscalPolicy({ saleId: 6, companyId: 1, decision: decision({ attempt: null, status: 'fiscal_disabled', reason: null }) })
    expect(disabled.fiscalResult).toBeNull()

    const skipped = await executeFiscalPolicy({ saleId: 7, companyId: 1, decision: decision({ attempt: null, status: 'skipped_by_operator', reason: null }) })
    expect(skipped.fiscalResult).toBeNull()

    expect(submitNfceHomologacao).not.toHaveBeenCalled()
    expect(submitNfeHomologacao).not.toHaveBeenCalled()
  })
})
