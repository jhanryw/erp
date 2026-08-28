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

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toBeNull()
  })

  it('só rascunho/pendente/erro/rejeitado (nunca autorizado) → null', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({ company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao', status: 'pending', danfe_path: null })
    fake.seedFiscalDocument({ company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao', status: 'authorization_failed', danfe_path: null })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toBeNull()
  })

  it('NFC-e autorizada → devolve documentType nfce + environment + danfePath', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z',
      danfe_path: '/notas_fiscais_consumidor/NFe123.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toEqual({ documentType: 'nfce', environment: 'homologacao', danfePath: '/notas_fiscais_consumidor/NFe123.html' })
  })

  it('NF-e autorizada → devolve documentType nfe', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', environment: 'producao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z',
      danfe_path: '/arquivos/danfe.pdf',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toEqual({ documentType: 'nfe', environment: 'producao', danfePath: '/arquivos/danfe.pdf' })
  })

  it('nunca vaza documento autorizado de outra empresa (escopo por company_id)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: 999, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/x.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toBeNull()
  })

  it('autorizado de outra venda nunca vaza (escopo por sale_id)', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID + 1, document_type: 'nfce', environment: 'homologacao',
      status: 'authorized', authorized_at: '2026-01-01T00:00:00.000Z', danfe_path: '/x.html',
    })
    ;(createAdminClient as any).mockImplementation(mockCreateAdminClient(fake))

    const result = await findAuthorizedFiscalDocument(SALE_ID, COMPANY_ID)
    expect(result).toBeNull()
  })
})
