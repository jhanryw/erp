import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { resolveChatwootLauncherUrl } from './_lib/resolveChatwootLauncherUrl'
import { Inbox } from './_components/inbox'

// Autenticação/sessão já garantidas pelo layout do (dashboard). Virou Server
// Component (era client puro) só para resolver company_id aqui — o Realtime
// do inbox (useCrmRealtime) precisa desse valor no browser para filtrar a
// subscription, e nenhum client component do projeto o conhecia antes disso.
// Autorização real de cada ação continua no backend (requireRole nas rotas
// /api/crm/*); isto aqui não é uma segunda fronteira de segurança.
//
// Botão "Abrir Chatwoot" (Fase "Espelhar Chatwoot no ERP" — alternativa ao
// iframe, descartado por inviabilidade de cookie cross-site, ver relatório
// da fase anterior): a integração é resolvida AQUI, server-side, reaproveitando
// o mesmo service da Fase 2 — nunca um endpoint novo, nunca api_token/secret
// chega ao client component (só a `settings.base_url`, já pública por natureza
// — é a URL de login do Chatwoot, não uma credencial).
export default async function ConversasPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null

  const integrationResult = profile?.company_id
    ? await getCompanyIntegration(profile.company_id, 'chatwoot')
    : null
  const chatwootUrl = resolveChatwootLauncherUrl(integrationResult?.ok ? integrationResult.data : null)

  return <Inbox companyId={profile?.company_id ?? null} chatwootUrl={chatwootUrl} />
}
