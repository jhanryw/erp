export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { UserRoleProvider } from '@/components/layout/user-context'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'
import { BottomTabBar } from '@/components/layout/mobile-nav'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Busca perfil completo (nome + role) do banco — fonte autoritativa
  const profile = await getUserProfile(user.id, user.email)

  return (
    // UserRoleProvider injeta nome e role no contexto de todos os Client Components filhos
    // (Sidebar, MobileNav) sem precisar de prop drilling.
    <UserRoleProvider userName={profile.name} userRole={profile.role}>
      <div className="flex h-screen bg-bg-root overflow-hidden">
        {/* Sidebar — oculta em mobile */}
        <div className="hidden lg:flex flex-shrink-0">
          <Sidebar />
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Topbar />

          <main className="flex-1 overflow-y-auto pb-20 lg:pb-0">
            <div className="p-4 lg:p-6 max-w-[1600px] mx-auto animate-fade-in">
              {children}
            </div>
          </main>
        </div>

        {/* Bottom tab bar — apenas mobile */}
        <BottomTabBar />
      </div>
    </UserRoleProvider>
  )
}
