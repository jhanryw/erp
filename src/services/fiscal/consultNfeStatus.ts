/**
 * Polling manual — Fase Fiscal 2B, seção 9 do pedido.
 *
 * Consulta o status atual de uma NF-e por `sale_id` (não por
 * `fiscal_document_id`, já que quem chama — UI/endpoint — só tem a venda).
 * Nunca automático — sem cron, sem intervalo, sem retry embutido. Cada
 * chamada é UMA consulta explícita, acionada por um admin (botão "verificar
 * status" na UI, ou reaproveitado internamente por `submitNfeHomologacao`
 * quando encontra uma linha `pending`).
 *
 * NÃO faz polling agressivo — não há loop, não há setInterval, não há
 * job agendado nesta fase (webhook fica pra fase posterior, por instrução
 * explícita).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { consultAndUpdateFiscalDocument, type SubmitNfeResult } from './submitNfeHomologacao'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export async function consultNfeStatus(saleId: number, companyId: number): Promise<ServiceOutcome<SubmitNfeResult>> {
  const admin = createAdminClient()

  const { data: row, error } = await (admin as any)
    .from('fiscal_documents')
    .select('id, provider_ref, status')
    .eq('company_id', companyId)
    .eq('sale_id', saleId)
    .eq('document_type', 'nfe')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return failure(error.message)
  if (!row) return failure('Nenhuma tentativa de emissão encontrada pra esta venda.', 404)

  return consultAndUpdateFiscalDocument(row.id, row.provider_ref, companyId)
}
