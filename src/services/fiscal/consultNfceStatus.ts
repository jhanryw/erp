/**
 * Polling manual de NFC-e — Fase Fiscal 4F. Mesmo papel de
 * `consultNfeStatus.ts` (NF-e): consulta o status atual por `sale_id`,
 * nunca automático — cada chamada é uma consulta explícita, acionada por
 * um admin ("Verificar status" na UI). Reaproveita
 * `consultAndUpdateNfceDocument` (mesma reconciliação já usada quando o
 * claim de `submitNfceHomologacao` devolve `reconciliation_required`) —
 * item 15 do pedido ("reaproveitando consulta quando possível").
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { consultAndUpdateNfceDocument } from './submitNfceHomologacao'
import type { SubmitNfeResult } from './submitNfeHomologacao'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export async function consultNfceStatus(saleId: number, companyId: number): Promise<ServiceOutcome<SubmitNfeResult>> {
  const admin = createAdminClient()

  const { data: row, error } = await (admin as any)
    .from('fiscal_documents')
    .select('id, provider_ref, status')
    .eq('company_id', companyId)
    .eq('sale_id', saleId)
    .eq('document_type', 'nfce')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return failure(error.message)
  if (!row) return failure('Nenhuma tentativa de emissão de NFC-e encontrada pra esta venda.', 404)

  return consultAndUpdateNfceDocument(row.id, row.provider_ref, companyId)
}
