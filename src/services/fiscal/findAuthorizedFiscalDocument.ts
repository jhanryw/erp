/**
 * Consulta se uma venda tem documento fiscal AUTORIZADO **num ambiente
 * específico** — usado pra decidir entre comprovante não fiscal (QR
 * interno Qarvon) e documento fiscal oficial (regra definitiva de
 * impressão/QR Code).
 *
 * `environment` é OBRIGATÓRIO, sem default — fundação homologação↔
 * produção (auditoria 2026-09-06): antes desta revisão a função pegava
 * "o mais recente autorizado, de qualquer ambiente", o que fazia uma
 * NFC-e de HOMOLOGAÇÃO (teste, sem valor fiscal) ser tratada exatamente
 * como uma de produção — escondendo o comprovante operacional e
 * redirecionando pro DANFE de teste como se fosse o documento oficial.
 * Nunca mais comportamento implícito aqui: quem chama decide
 * explicitamente QUAL ambiente está perguntando.
 *
 * Uso esperado:
 *   - Decisões operacionais normais (substituir comprovante, redirect
 *     automático pro DANFE oficial, "venda fiscalizada") → chamar
 *     SEMPRE com `environment: 'producao'`. Só um autorizado de
 *     PRODUÇÃO conta como documento fiscal oficial da venda.
 *   - Acesso explícito a um documento de homologação (debug/teste,
 *     nunca automático/implícito) → chamar com `environment:
 *     'homologacao'`, sabendo que o resultado NUNCA deve ser tratado
 *     como fiscalização oficial.
 *
 * `status='authorized'` é o ÚNICO status que conta — pending/processing/
 * rejected/error/draft/cancelled nunca são tratados como autorizados
 * (mesma régua já usada em `getNfceDanfeData.ts`/`documento-fiscal-card.
 * tsx`). Escopado por `company_id` direto na tabela (coluna própria, sem
 * precisar de join com `sales`).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

export interface AuthorizedFiscalDocument {
  documentType: 'nfce' | 'nfe'
  environment: FocusEnvironment
  danfePath: string | null
}

export interface FindAuthorizedFiscalDocumentParams {
  saleId: number
  companyId: number
  /** Sem default deliberadamente — nunca comportamento implícito sobre qual ambiente está sendo consultado. */
  environment: FocusEnvironment
}

export async function findAuthorizedFiscalDocument(params: FindAuthorizedFiscalDocumentParams): Promise<AuthorizedFiscalDocument | null> {
  const { saleId, companyId, environment } = params
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('fiscal_documents')
    .select('document_type, environment, danfe_path')
    .eq('sale_id', saleId)
    .eq('company_id', companyId)
    .eq('environment', environment)
    .eq('status', 'authorized')
    // Uma venda deveria ter no máximo UM tipo de documento autorizado por
    // ambiente (exclusividade legal NF-e/NFC-e, decidida por
    // `resolveFiscalDocumentType`, e reforçada por
    // `uq_fiscal_documents_sale_authorized` desde 202609061000) —
    // `order by authorized_at desc limit 1` garante que, mesmo numa
    // inconsistência hipotética, pegamos o mais recente, nunca lança.
    .order('authorized_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { document_type: 'nfce' | 'nfe'; environment: FocusEnvironment; danfe_path: string | null } | null }

  if (!data) return null

  return { documentType: data.document_type, environment: data.environment, danfePath: data.danfe_path }
}
