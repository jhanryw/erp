/**
 * Consulta se uma venda já tem documento fiscal AUTORIZADO — usado pra
 * decidir entre comprovante não fiscal (QR interno Qarvon) e documento
 * fiscal (regra definitiva de impressão/QR Code): uma vez autorizado,
 * NUNCA mais mostra o QR interno pra essa venda.
 *
 * `status='authorized'` é o ÚNICO status que conta — pending/processing/
 * rejected/error/draft/cancelled nunca são tratados como autorizados
 * (mesma régua já usada em `getNfceDanfeData.ts`/`documento-fiscal-card.
 * tsx`). Escopado por `company_id` direto na tabela (coluna própria, sem
 * precisar de join com `sales`).
 *
 * Uma venda deveria ter no máximo UM tipo de documento autorizado
 * (exclusividade legal NF-e/NFC-e, decidida por `resolveFiscalDocumentType`)
 * — `order by authorized_at desc limit 1` garante que, mesmo numa
 * inconsistência hipotética, pegamos o mais recente, nunca lança.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

export interface AuthorizedFiscalDocument {
  documentType: 'nfce' | 'nfe'
  environment: FocusEnvironment
  danfePath: string | null
}

export async function findAuthorizedFiscalDocument(saleId: number, companyId: number): Promise<AuthorizedFiscalDocument | null> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('fiscal_documents')
    .select('document_type, environment, danfe_path')
    .eq('sale_id', saleId)
    .eq('company_id', companyId)
    .eq('status', 'authorized')
    .order('authorized_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { document_type: 'nfce' | 'nfe'; environment: FocusEnvironment; danfe_path: string | null } | null }

  if (!data) return null

  return { documentType: data.document_type, environment: data.environment, danfePath: data.danfe_path }
}
