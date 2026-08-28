import { describe, it, expect, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthorizedFiscalDocument } from './findAuthorizedFiscalDocument'
import { createFakeAdmin, mockCreateAdminClient } from './testFakeAdminClient'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 42

describe('findAuthorizedFiscalDocument', () => {
  it('nenhum fiscal_documents pra venda → null', async () => {
    const fake = createFakeAdmin()
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result).toBeNull()
  })

  it('só rascunho/pendente/erro/rejeitado (nunca autorizado) → null', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({ company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao', status: 'pending', danfe_path: null })
    fake.seedFiscalDocument({ company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao', status: 'authorization_failed', danfe_path: null })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toBeNull()
  })

  it('NFC-e autorizada em homologação, consultada com environment=homologacao → devolve documentType nfce + danfePath', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z',
      danfe_path: '/notas_fiscais_consumidor/NFe123.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ documentType: 'nfce', environment: 'homologacao', danfePath: '/notas_fiscais_consumidor/NFe123.html' })
  })

  it('NF-e autorizada em produção, consultada com environment=producao → devolve documentType nfe', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', environment: 'producao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z',
      danfe_path: '/arquivos/danfe.pdf',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result).toEqual({ documentType: 'nfe', environment: 'producao', danfePath: '/arquivos/danfe.pdf' })
  })

  // ─── Fundação homologação↔produção (itens 12/13 da lista de testes obrigatórios) ───

  it('12) só homologação autorizada + pergunta por produção → null (nunca trata homologação como documento oficial)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/homolog.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result).toBeNull()
  })

  it('13) homologação E produção autorizadas + pergunta por produção (finalidade oficial) → devolve a de produção', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/homolog.html',
    })
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'producao',
      status: 'authorized', authorized_at: '2026-01-02T00:00:00.000Z', danfe_path: '/oficial.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'producao' })
    expect(result).toEqual({ documentType: 'nfce', environment: 'producao', danfePath: '/oficial.html' })
  })

  it('homologação E produção autorizadas + pergunta explícita por homologação → devolve a de homologação (uso de debug/teste, nunca implícito)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/homolog.html',
    })
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'producao',
      status: 'authorized', authorized_at: '2026-01-02T00:00:00.000Z', danfe_path: '/oficial.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toEqual({ documentType: 'nfce', environment: 'homologacao', danfePath: '/homolog.html' })
  })

  it('nunca vaza documento autorizado de outra empresa (escopo por company_id)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: 999, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/x.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toBeNull()
  })

  it('autorizado de outra venda nunca vaza (escopo por sale_id)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID + 1, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/x.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument({ saleId: SALE_ID, companyId: COMPANY_ID, environment: 'homologacao' })
    expect(result).toBeNull()
  })
})
