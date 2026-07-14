import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { Inbox } from './_components/inbox'

// Autenticação/sessão já garantidas pelo layout do (dashboard). Virou Server
// Component (era client puro) só para resolver company_id aqui — o Realtime
// do inbox (useCrmRealtime) precisa desse valor no browser para filtrar a
// subscription, e nenhum client component do projeto o conhecia antes disso.
// Autorização real de cada ação continua no backend (requireRole nas rotas
// /api/crm/*); isto aqui não é uma segunda fronteira de segurança.
export default async function ConversasPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null

  return <Inbox companyId={profile?.company_id ?? null} />
}
