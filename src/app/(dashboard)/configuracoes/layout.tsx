import { requirePageRole } from '@/lib/auth/requirePageRole'

// Fase 2 — bloqueia TODO o módulo Configurações para usuario no servidor,
// inclusive digitando a URL direto. Cobre todas as subpáginas automaticamente
// (várias são 'use client' e não podem chamar requirePageRole() sozinhas —
// um layout server-side é o único jeito de bloquear todas de uma vez).
// Páginas que já exigem 'admin' individualmente (usuarios, colecoes,
// nuvemshop, parametros) continuam exigindo admin — este layout só garante
// o piso mínimo de 'gerente' para o resto do módulo.
export default async function ConfiguracoesLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requirePageRole('gerente')
  return <>{children}</>
}
