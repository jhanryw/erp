// ⚠️ DEV BYPASS — verificação de sessão removida. Acesso direto ao dashboard.
// force-dynamic: evita que o Next.js tente pré-renderizar páginas que dependem do banco
export const dynamic = 'force-dynamic'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'
import { BottomTabBar } from '@/components/layout/mobile-nav'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // DEV: auth check removido — sem redirect para /login

  return (
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
  )
}
