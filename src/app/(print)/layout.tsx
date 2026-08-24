// Route group isolado para páginas de impressão (hoje: comprovante não
// fiscal). Propósito único: NUNCA herdar o shell do ERP (Sidebar, Topbar,
// BottomTabBar de (dashboard)/layout.tsx) — a auditoria confirmou que o
// shell inteiro aparecia na tela E na impressão de /vendas/[id]/comprovante
// só porque a rota vivia sob o grupo (dashboard). Route groups do App
// Router não afetam a URL — só qual layout.tsx é aplicado — então mover a
// pasta pra cá preserva exatamente a mesma URL (/vendas/[id]/comprovante)
// com um layout diferente.
//
// Autenticação NÃO é perdida: cada página deste grupo já faz sua própria
// checagem (requirePageRole/redirect), independente do layout — não
// depende do redirect que (dashboard)/layout.tsx fazia. O middleware
// (src/middleware.ts) também continua exigindo sessão pra qualquer rota
// fora de PUBLIC_PATHS, independente de qual route group a serve.
//
// Nenhum Sidebar/Topbar/BottomTabBar/UserRoleProvider aqui de propósito —
// só repassa os children direto pro <body> do layout raiz.
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
