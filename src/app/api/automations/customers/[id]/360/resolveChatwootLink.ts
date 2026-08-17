import { resolvePersonForCustomer } from '@/lib/integrations/chatwoot/reconciliation'
import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { findLinkForEntity } from '@/services/integrations/external-entity-links.service'

export interface ChatwootLinkInfo {
  linked: boolean
  contact_id: string | null
}

/**
 * Reaproveita `resolvePersonForCustomer` (Fase 4) + `findLinkForEntity`
 * (Fase 2) — mesmo caminho canônico já usado pra sincronizar atributos com
 * o Chatwoot, nunca uma segunda lógica de resolução (seção 12 do pedido).
 * Nunca cria vínculo — só leitura. Qualquer desfecho que não seja "vínculo
 * ativo confirmado" vira `linked:false` (sem distinguir pro n8n SE é porque
 * a pessoa é ambígua, não existe, ou não há integração — esse detalhe é
 * operacional do ERP, não algo que uma automação externa precise decidir).
 *
 * Vive fora de route.ts porque o Next.js App Router só aceita exports
 * específicos (GET/POST/dynamic/...) em arquivos route.ts — qualquer outro
 * export quebra o build ("is not a valid Route export field").
 */
export async function resolveChatwootLink(companyId: number, customerId: number): Promise<ChatwootLinkInfo> {
  const integrationResult = await getCompanyIntegration(companyId, 'chatwoot')
  if (!integrationResult.ok || !integrationResult.data || integrationResult.data.status !== 'active') {
    return { linked: false, contact_id: null }
  }

  const personResult = await resolvePersonForCustomer(customerId, companyId)
  if (!personResult.ok || personResult.data.status !== 'resolved') {
    return { linked: false, contact_id: null }
  }

  const linkResult = await findLinkForEntity(integrationResult.data.id, 'crm_person', personResult.data.personId, 'contact')
  if (!linkResult.ok || !linkResult.data) {
    return { linked: false, contact_id: null }
  }

  return { linked: true, contact_id: linkResult.data.external_id }
}
