import { MessageSquare, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { resolveChatwootLauncherUrl } from './_lib/resolveChatwootLauncherUrl'

/**
 * "CRM > Conversas" — a partir da Fase "Auditoria de remoção da inbox
 * legada", esta página deixou de ser uma inbox própria (lista + thread +
 * composer + realtime sobre crm_conversations/crm_messages) e virou só um
 * launcher pro Chatwoot, que é a central de atendimento real (WhatsApp +
 * Instagram). Nenhum client component — 100% Server Component, sem estado,
 * sem fetch de conversas.
 *
 * RBAC inalterado: acesso à página continua atrás da mesma sessão/role
 * (`requireRole('usuario')`) já exigida pelas rotas que existiam antes —
 * nada foi afrouxado nem endurecido aqui.
 *
 * A integração é resolvida server-side (mesmo service da Fase 2,
 * `getCompanyIntegration`) — nenhum `api_token`/secret chega ao client,
 * só a URL final de `settings.base_url` + `external_account_id`, já
 * públicos por natureza (é a URL de login do Chatwoot, não uma credencial).
 */
export default async function ConversasPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null

  const integrationResult = profile?.company_id
    ? await getCompanyIntegration(profile.company_id, 'chatwoot')
    : null
  const chatwootUrl = resolveChatwootLauncherUrl(integrationResult?.ok ? integrationResult.data : null)

  return (
    <div className="flex flex-col items-center justify-center h-[calc(100vh-160px)] min-h-[400px] text-center gap-4">
      <MessageSquare className="w-10 h-10 text-text-muted" />
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Atendimento</h1>
        <p className="text-sm text-text-secondary mt-1">
          O atendimento ao cliente (WhatsApp, Instagram) é feito diretamente no Chatwoot.
        </p>
      </div>

      {chatwootUrl ? (
        <a
          href={chatwootUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium bg-brand hover:bg-brand-light text-white shadow-sm transition-colors"
        >
          Abrir Chatwoot
          <ExternalLink className="w-4 h-4" />
        </a>
      ) : (
        <span
          className="inline-flex items-center h-10 px-4 rounded-lg text-sm text-text-muted border border-border border-dashed"
          title="Nenhuma integração Chatwoot ativa com base_url/external_account_id configurados para esta empresa."
        >
          Chatwoot não configurado
        </span>
      )}
    </div>
  )
}
