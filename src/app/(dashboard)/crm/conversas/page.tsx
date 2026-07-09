'use client'

import { Inbox } from './_components/inbox'

// Autenticação/sessão já garantidas pelo layout do (dashboard) — mesma
// convenção de outras páginas majoritariamente client-side deste projeto
// (ex.: cashback/configuracao). Autorização real de cada ação continua no
// backend (requireRole nas rotas /api/crm/*).
export default function ConversasPage() {
  return <Inbox />
}
